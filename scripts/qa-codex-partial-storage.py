"""Real-app QA for an existing native DB missing legacy conversations.

Requires a built worktree, Windows Codex 0.155.1 and an authenticated QA home.
Uses real provider calls. All new files stay under a unique .tmp directory.
Member actions use the real member-scoped MCP endpoint. Direct HTTP is used
for fixture setup, inspection, close/resume and storage administration, which
have no corresponding member tool. Codex thread/archive is fixture setup via
the official app-server API; no source DB rows are deleted to simulate loss.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--auth-source', required=True, type=pathlib.Path)
parser.add_argument('--codex', required=True, type=pathlib.Path)
parser.add_argument('--model', default='gpt-6-luna')
args = parser.parse_args()
assert os.name == 'nt'
assert args.auth_source.name == 'auth.json' and args.auth_source.is_file()
assert args.codex.is_file()
assert (ROOT/'dist/main/main.js').is_file(), 'Build this worktree first'
CASE = pathlib.Path(tempfile.mkdtemp(prefix='partial-storage-', dir=ROOT/'.tmp')).resolve()
HOME, DATA, WORKSPACE = [CASE/name for name in ['home','user-data','workspace']]
for directory in [HOME,DATA,WORKSPACE]: directory.mkdir()
assert CASE.is_relative_to(ROOT/'.tmp')
shutil.copyfile(args.auth_source,HOME/'auth.json')
(HOME/'config.toml').write_text('cli_auth_credentials_store="file"\n',encoding='utf-8')
(DATA/'settings.json').write_text(json.dumps({'locale':'ko','debugLogging':True,'codexExecutablePath':str(args.codex),'idleSleepEnabled':False}))
env=os.environ.copy()
for key in ['ELECTRON_RUN_AS_NODE','AGENTPARTY_E2E','CODEX_SQLITE_HOME','AGENTPARTY_CODEX_BIN','AGENTPARTY_CODEX_ARGS']:
    env.pop(key,None)
env.update(CODEX_HOME=str(HOME),AGENTPARTY_NATIVE_CODEX_HOME=str(HOME),
    AGENTPARTY_USER_DATA=str(DATA),AGENTPARTY_AUTOMATION_PORT='0',
    AGENTPARTY_ALLOW_MULTI_INSTANCE='1',AGENTPARTY_QA='1')
# The harness's inherited CODEX_SQLITE_HOME must never reach a fixture server.
os.environ.pop('CODEX_SQLITE_HOME',None)
os.environ['CODEX_HOME']=str(HOME)
spec=importlib.util.spec_from_file_location('storage_fixture',ROOT/'scripts/codex-storage-transition.py')
fixture=importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
request={'command':str(args.codex),'args':[]}
base=None
validated_app=False
party=None
report={'case':str(CASE),'model':args.model,'steps':[]}


def checkpoint(label, **details):
    report['steps'].append({'label':label,**details})
    (CASE/'result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(label,json.dumps(details),flush=True)


def api(route, data=None):
    req=urllib.request.Request(base+route,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
    try: return json.load(urllib.request.urlopen(req,timeout=45))
    except urllib.error.HTTPError as error: raise RuntimeError(error.read().decode()) from error


def mcp(tool, arguments):
    result=api('/api/parties/'+party+'/members/main/mcp-tools/'+tool,{'arguments':arguments})
    assert result.get('ok') and result.get('transport')=='mcp-stdio',result
    return result


def member(name):
    return next(m for m in api('/api/state')['party']['members'] if m['name']==name)


def reply(name, prompt, expected):
    def messages():
        blocks=api('/api/party/members/'+name+'/transcript')['blocks']
        errors=[b.get('text') for b in blocks if b.get('kind')=='error']
        assert not errors,errors
        return [b.get('text') for b in blocks if b.get('kind')=='assistant']
    before=len(messages())
    mcp('send',{'to':name,'content':prompt+' Do not use tools.'})
    for i in range(180):
        texts=messages()
        if len(texts)>before:
            assert len(texts)==before+1 and texts[-1]==expected, texts[-2:]
            return member(name)['harnessSessionId']
        if i%15==0: print('Waiting:',name,i,flush=True)
        time.sleep(1)
    raise AssertionError('No real reply from '+name)


def create(name, token):
    mcp('member-create',{'name':name,'role':'QA only. Follow explicit prompts. Do not edit files.',
        'harness':'codex','model':args.model,'effort':'low','serviceTier':'inherit',
        'location':{'host':'windows','cwd':str(ROOT.parent/'AgentPartyApp')},
        'codexPolicy':{'sandbox':'read-only','approval':'never','guardian':False}})
    return reply(name,'Reply exactly '+token+'.',token)


def close_all():
    for m in api('/api/state')['party']['members']:
        if m.get('status')!='closed': api('/api/party/members/'+m['name']+'/close',{})


def resume(name):
    if member(name).get('status')=='closed': api('/api/party/members/'+name+'/resume',{})


def transition(mode):
    result=api('/api/codex/storage/transition',{'mode':mode,'externalCodexStopped':True,'acceptGoalReset':True})
    assert result['job']['state']=='running', result
    for i in range(300):
        result=api('/api/codex/storage')
        if result['job']['state']!='running': return result
        if i%15==0: print('Transition:',mode,result['job']['phase'],flush=True)
        time.sleep(1)
    raise AssertionError('Storage job timed out')


def indexed(tid):
    file=HOME/'state_5.sqlite'
    with fixture.connect(file) as db:
        return db.execute('select archived from threads where id=?',(tid,)).fetchone()


def legacy_home(tid):
    directory=next(p for t,p in fixture.legacy_targets(DATA) if t==tid)
    assert directory.resolve().is_relative_to(DATA)
    return directory


def official(directory):
    assert directory.resolve().is_relative_to(CASE)
    return fixture.Server(request,CASE/'fixture.stderr',HOME,directory)


try:
    with (CASE/'app.stdout').open('w') as out, (CASE/'app.stderr').open('w') as err:
        subprocess.Popen(['node','scripts/launch-electron.mjs','--workspace',str(WORKSPACE)],
            cwd=ROOT,env=env,stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(120):
        for file in (WORKSPACE/'.agent_party_app/instances').glob('*.json'):
            base=json.loads(file.read_text(encoding='utf-8-sig'))['baseUrl']
            try:
                state=api('/api/state')
                assert pathlib.Path(state['runtime']['appRoot']).resolve().is_relative_to(ROOT)
                assert pathlib.Path(state['logs']['logFilePath']).resolve().is_relative_to(DATA)
                validated_app=True
                break
            except OSError: base=None
        if base: break
        time.sleep(.5)
    assert base,'App did not start'
    (CASE/'connection.json').write_text(json.dumps({'base':base,'home':str(HOME),'data':str(DATA)}))
    assert api('/api/codex/storage')['mode']=='native'
    api('/api/parties',{'name':'Partial Codex storage QA'})
    party=api('/api/state')['party']['currentPartyId']
    for _ in range(120):
        if api('/api/state')['codexModels']['status']=='ready': break
        time.sleep(1)
    a=create('native-a','NATIVE_A_431')
    close_all()
    result=transition('legacy')
    assert result['job']['state']=='complete' and result['mode']=='legacy',result
    resume('main')
    b=create('legacy-b','LEGACY_B_862')
    close_all()
    assert indexed(a) is not None and indexed(b) is None
    checkpoint('Fixture: native DB contains A, legacy-only B is absent',a=a,b=b)
    result=transition('native')
    assert result['job']['state']=='complete' and result['mode']=='native',result
    assert indexed(a) is not None and indexed(b) is not None
    resume('main'); resume('native-a'); resume('legacy-b')
    assert reply('native-a','Repeat your previous exact response.','NATIVE_A_431')==a
    assert reply('legacy-b','Repeat your previous exact response.','LEGACY_B_862')==b
    assert reply('legacy-b','Now reply exactly NATIVE_B_LATEST_973.','NATIVE_B_LATEST_973')==b
    close_all()
    rollback=transition('legacy')
    assert rollback['job']['state']=='complete' and rollback['mode']=='legacy',rollback
    resume('main'); resume('legacy-b')
    assert reply('legacy-b','Repeat your previous exact response.','NATIVE_B_LATEST_973')==b
    checkpoint('PASS: missing normal conversation migrated; A/B retained; latest native reply survived rollback')
    c=create('archived-c','ARCHIVED_C_514')
    close_all()
    source=legacy_home(c)
    server=official(source)
    try:
        expected=fixture.thread_messages(server.read(c))
        assert sum(expected['assistant'].values())==1
        server.call('thread/archive',{'threadId':c})
        assert fixture.thread_messages(server.read(c))==expected
    finally: server.close()
    assert indexed(a) is not None and indexed(c) is None
    with fixture.connect(source/'state_5.sqlite') as db:
        assert db.execute('select archived from threads where id=?',(c,)).fetchone()==(1,)
    checkpoint('Fixture: native DB exists, archived legacy-only C is absent',c=c)
    result=transition('native')
    if result['job']['state']=='complete':
        assert result['mode']=='native' and indexed(c)==(1,)
        server=official(HOME)
        try: assert fixture.thread_messages(server.read(c))==expected
        finally: server.close()
        checkpoint('PASS: missing archived conversation also migrated without unarchiving',job=result['job'])
    else:
        assert result['job']['state']=='failed' and result['mode']=='legacy',result
        assert c in result['job']['error'] and 'archived' in result['job']['error'].lower(),result
        server=official(source)
        try: assert fixture.thread_messages(server.read(c))==expected
        finally: server.close()
        with fixture.connect(source/'state_5.sqlite') as db:
            assert db.execute('select archived from threads where id=?',(c,)).fetchone()==(1,)
        resume('main'); resume('legacy-b')
        assert reply('legacy-b','Repeat your previous exact response.','NATIVE_B_LATEST_973')==b
        checkpoint('REPRODUCED: archived C blocks transition; legacy mode, archive and B latest context preserved',job=result['job'])
    report['completed']=True
    checkpoint('QA complete')
except Exception as error:
    checkpoint('QA failed',error=str(error))
    raise
finally:
    if base and validated_app:
        try: api('/api/window/close',{})
        except OSError: pass
    print('Private artifacts retained at',str(CASE),flush=True)
