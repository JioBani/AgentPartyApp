# -*- coding: utf-8 -*-
"""AI-Model-Benchmarks-2026.xlsx (as-of 2026-06-27).
정규화 = baseline-floor min-max: (score - floor) / (max - floor) * 100, 0 미만 클램프.
 floor = Haiku 4.5 점수(9벤치) + Gemini 2.5 Flash(LiveCodeBench) + 0(ARC-AGI-2/FrontierMath).
 "0 = baseline(중급) 수준, 100 = 표내 최고". 죽은 2차(SWE-Live/Aider/SWE-Lancer/GAIA/BigCode) 제외.
탭: README / Leaderboard(1행통합) / 1차 벤치 / 2차 벤치 / Benchmark-Info / Frontier-Anchors / Sources.
"""
import re, os
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
N = "n/a"

# ===== 12 benchmarks (5 dead 2차 제외) =====
# 1차(8): 0 SWEPro 1 TBench 2 LCB 3 TAU2 | 4 GPQA 5 HLE 6 ARC2 7 FM
# 2차(4): 8 MMLU-Pro 9 AIME 10 MMMU | 11 OSWorld
BNAME = ["SWE-bench Pro","Terminal-Bench v2.1","LiveCodeBench","TAU2 (Telecom)",
         "GPQA Diamond","HLE","ARC-AGI-2","FrontierMath",
         "MMLU-Pro","AIME","MMMU","OSWorld-Verified"]
# baseline 3종 (벤치별 floor). 빈 벤치는 0(=max정규화 폴백)
FLOOR_HAIKU  = {0:39.5,1:28.3,2:71.3,3:83.0,4:73.3,5:9.7, 6:0.0,7:0.0,8:80.0,9:80.7,10:73.2,11:50.7}
FLOOR_SONNET = {0:0.0, 1:65.4,2:0.0, 3:79.5,4:79.9,5:49.0,6:58.3,7:0.0,8:79.2,9:0.0, 10:0.0, 11:72.1}
FLOOR_GPT4O  = {0:33.0,1:0.0, 2:39.1,3:25.1,4:53.6,5:2.3, 6:0.0,7:1.0,8:74.7,9:9.3, 10:69.1,11:0.0}
FLOOR = FLOOR_HAIKU  # primary
FLOOR_SRC = {0:"Haiku4.5",1:"Haiku4.5",2:"Gem2.5Flash",3:"Haiku4.5",4:"Haiku4.5",5:"Haiku4.5",
             6:"0(고난도)",7:"0(고난도)",8:"Haiku4.5",9:"Haiku4.5",10:"Haiku4.5",11:"Haiku4.5"}
W = {0:1.0,1:1.0,2:0.6,3:0.7, 4:0.5,5:1.0,6:0.8,7:0.7, 8:0.4,9:0.3,10:0.4, 11:0.6}
COD1=[0,1,2,3]; GEN1=[4,5,6,7]
COD2=[11]; GEN2=[8,9,10]
P1=COD1+GEN1; CODA=COD1+COD2; GENA=GEN1+GEN2; ALL=list(range(12))

# ===== DATA (Model, Provider, In, Out, mix, Ctx, src, 17-tuple) — 17개 그대로 두고 아래서 12개로 슬라이스 =====
# 17-index: 0 SWEPro 1 TBench 2 LCB 3 TAU2 4 GPQA 5 HLE 6 ARC2 7 FM 8 MMLU-Pro 9 AIME 10 MMMU
#           11 SWE-Live 12 Aider 13 SWE-Lancer 14 GAIA 15 OSWorld 16 BigCode
KEEP = [0,1,2,3,4,5,6,7,8,9,10,15]   # 12개만 유지
D = [
 ("Qwen3 Coder Flash","Qwen",0.195,0.975,0.39,"1M","OR",(N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("Qwen3.6 Flash","Qwen",0.1875,1.125,0.42,"1M","OR",(N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("GPT-5.4 nano","OpenAI",0.20,1.25,0.46,"—","API",("52.4 (vendor)",N,N,"76.0","81.7","37.7",N,N,N,N,N,N,N,N,N,"39.0",N)),
 ("MiniMax-M3","MiniMax",0.30,1.20,0.53,"1.05M","OR",("~59 (vendor, 미검증)",N,N,"88.9","92.9",N,N,N,"84.2 (single-src)",N,N,N,N,N,N,"70.1",N)),
 ("DeepSeek V4 Pro","DeepSeek",0.435,0.87,0.54,"1.05M","OR",("55.4 Max / 54.4 High / 52.1 base (vendor)","67.9 (secondary)","93.5 Max / 89.8 High / 56.8 def","96.2","90.1 Max / 89.1 High","37.7",N,N,"82.9 (BenchLM) / ~89",N,N,N,N,N,N,N,N)),
 ("Qwen3.7 Plus","Qwen",0.32,1.28,0.56,"1M","OR",("57.6 (vendor)","70.3 (secondary)","89.6","93.0","90.3",N,N,N,"88.5",N,N,N,N,N,N,"73.3",N)),
 ("Gemini 3.1 Flash Lite","Google",0.25,1.50,0.56,"1.05M","OR",(N,N,N,"31.3","82.2",N,N,N,"83.0","16.7 (AIME-25)","73.7",N,N,N,N,N,N)),
 ("Qwen3 Coder 480B A35B","Qwen",0.22,1.80,0.62,"262K","OR",("38.7 (SEAL std)","27.2/25.4 (harness)",N,N,N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("Qwen3.6 27B","Qwen",0.2885,2.65,0.88,"262K","OR",("53.5 (vendor)","24.6 (35B-A3B)","83.9","94.2",N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("Kimi K2 Thinking","Moonshot",0.60,2.50,1.08,"262K","OR",(N,"35.7",N,N,N,"44.9 (w/tools)",N,N,N,"100 (AIME-25)",N,N,N,N,N,N,N)),
 ("Grok Build 0.1","xAI",1.00,2.00,1.25,"256K","OR",(N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("Qwen3 Coder Plus","Qwen",0.65,3.25,1.30,"1M","OR",(N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("Kimi K2.6","Moonshot",0.66,3.41,1.35,"262K","OR",("58.6 (vendor, open)","66.7 (secondary)","89.6","95.9","90.5–91.1","34.7 (54.0 w/tools)",N,N,N,"96.4 (AIME-26, single-src)",N,N,N,N,N,"73.1",N)),
 ("Kimi K2.7 Code","Moonshot",0.74,3.50,1.43,"262K","OR",("n/a (~58.6 주장, 논란)",N,N,"90.1","89.6",N,N,N,N,N,N,N,N,N,N,N,N)),
 ("GLM-5.2","Z.AI",0.95,3.00,1.46,"1.05M","OR",("62.1 (vendor, open)","n/a (GLM5.1=58.7)","n/a (GLM4.7=84.9)","99.1 (max)","89.5–91.2","54.7",N,N,N,N,N,N,N,N,N,N,N)),
 ("Grok 4.3","xAI",1.25,2.50,1.56,"1M","OR",(N,N,N,"97.7 (high)","90.1","35.0",N,N,N,N,N,N,N,N,N,N,N)),
 ("Grok 4.20","xAI",1.25,2.50,1.56,"2M","OR",("51.8 (vendor)","57.3 (Reasoning)",N,N,"88.5",N,"53.3",N,N,N,N,N,N,N,N,N,N)),
 ("Grok 4.20 multi-agent","xAI",1.25,2.50,1.56,"2M","OR",(N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("GPT-5.4 mini","OpenAI",0.75,4.50,1.69,"400K","API",("54.4 (vendor)",N,N,"83.3","87.5","41.5",N,N,N,N,N,N,N,N,N,"72.1",N)),
 ("Qwen3.7 Max","Qwen",1.25,3.75,1.88,"1M","OR",("60.6 (vendor)","69.7 (secondary)","91.6","94.7","92.3–92.4","41.4",N,N,"89.6",N,N,N,N,N,N,N,N)),
 ("Claude Haiku 4.5 (기준선)","Anthropic",1.00,5.00,2.00,"200K","OR",("39.5 (SEAL std)","28.3 (Terminus2)",N,N,"73.3","9.7",N,N,"80.0","80.7","73.2",N,N,N,N,"50.7",N)),
 ("Qwen3.6 Max Preview","Qwen",1.04,6.24,2.34,"262K","OR",("57.3 (vendor)",N,N,"95.9","88.8",N,N,N,N,N,N,N,N,N,N,N,N)),
 ("Magistral Medium 2506","Mistral",2.00,5.00,2.75,"41K","API",(N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("Gemini 3.5 Flash","Google",1.50,9.00,3.38,"1.05M","OR",("55.1 (vendor)","76.2 (secondary)","n/a (90.8 'Flash Preview' AA)","95.3","92.2–92.7","40.2","72.1 (self-rep)",N,N,N,N,N,N,N,N,"78.4",N)),
 ("Gemini 3.x Pro","Google",2.00,12.00,4.50,"1.05M","OR",("54.2 vendor / 46.1 SEAL","74.4–70.7 (harness) / 80.2 (v2.0)","91.7 (high, AA '3 Pro')","95.6 (3.1 Pro)","94.1–94.3 (high think)","44.7–46.4","77.1 (self-rep)",N,"89.8 (high)","100 (AIME-25)","n/a (MMMU-Pro 81.0)",N,N,N,"46.1 (3.1 Pro)",N,N)),
 ("GPT-5.3-Codex","OpenAI",1.75,14.00,4.81,"—","API",("56.8 (vendor)","78.4 (SageAgent)",N,"86.0","91.5",N,N,N,N,N,N,N,N,N,N,"64.7",N)),
 ("GPT-5.4","OpenAI",2.50,15.00,5.63,"1M","API",("57.7 vendor / 59.1 SEAL(xhigh)","57.6 (best pub)",N,"87.1","93.3 xhigh / 92.0–92.8 def","36.2 (xhigh)","73.3 base / 83.3 Pro","78.6 (T1-3)",N,N,N,N,N,N,"48.2","75.0",N)),
 ("Claude Sonnet 4.6","Anthropic",3.00,15.00,6.00,"1M","OR",(N,"65.4/59.1 (secondary)",N,"79.5","79.9","49.0","58.3 (self-rep)",N,"79.2",N,N,N,N,N,"45.5","72.1",N)),
 ("Claude Opus 4.8","Anthropic",5.00,25.00,10.00,"1M","OR",("69.2 (vendor, 가용 1위)","78.9 (Claude Code) / 84.6 (AA max)",N,"94.4","93.6 / 92.0(AA)","57.9 / 45.7(no-tool AA)",N,"80.0 (T1-3) / 56.1 (T4)",N,N,N,N,N,N,N,"83.4",N)),
 ("GPT-5.5","OpenAI",5.00,30.00,11.25,"1.05M","OR",("58.6 (vendor)","83.4 (Codex CLI) / 84.3 (xhigh AA)",N,"93.9","94.0 xhigh / 93.2 high","52.2","85.0 (verified, xhigh)","85.3 (T1-3) / 72.5 (T4)",N,N,N,N,N,N,N,"78.7",N)),
 ("Claude Fable 5","Anthropic",10.00,50.00,20.00,"1M","OR",("80.0–80.3 (vendor; 접근중단)","83.1 (Claude Code) / 84.6 (AA)","89.78 (vals)",N,N,"64.5 / 53.3 (AA)",N,"87.0 (T1-3) / 87.8 (T4 ⚠)",N,N,N,N,N,N,"52.3","85.0",N)),
 ("Claude Opus 4.8 Fast","Anthropic",10.00,50.00,20.00,"1M","OR",(N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N)),
 ("GPT-5.4 Pro","OpenAI",30.00,180.00,67.50,"1M","API",(N,N,N,N,"94.6 (xhigh)","44.3–58.7","83.3",N,N,N,N,N,N,N,"50.5",N,N)),
 ("GPT-5.5 Pro","OpenAI",30.00,180.00,67.50,"1.05M","OR",(N,N,N,N,"93.9 (xhigh)","57.2",N,"87.7 (T1-3) / 78.0 (T4)",N,N,N,N,N,N,N,N,N)),
]
# 17 -> 12 슬라이스
D = [(*r[:7], tuple(r[7][i] for i in KEEP)) for r in D]

# 출시일 (조사: 공식 발표/모델카드 기준, YYYY-MM-DD 또는 YYYY-MM)
REL = {
 "Claude Fable 5":"2026-06-09","Claude Opus 4.8":"2026-05-28","Claude Opus 4.8 Fast":"2026-05-28",
 "Claude Sonnet 4.6":"2026-02-17","Claude Haiku 4.5 (기준선)":"2025-10-15",
 "GPT-5.5":"2026-04-23","GPT-5.5 Pro":"2026-04-23","GPT-5.4":"2026-03-05","GPT-5.4 Pro":"2026-03-05",
 "GPT-5.4 mini":"2026-03-17","GPT-5.4 nano":"2026-03-17","GPT-5.3-Codex":"2026-02-05",
 "Gemini 3.x Pro":"2026-02-19","Gemini 3.5 Flash":"2026-05-19","Gemini 3.1 Flash Lite":"2026-03",
 "Grok 4.3":"2026-04-30","Grok 4.20":"2026-02-17","Grok 4.20 multi-agent":"2026-03-09","Grok Build 0.1":"2026-05-20",
 "DeepSeek V4 Pro":"2026-04-24","Kimi K2.6":"2026-04-20","Kimi K2.7 Code":"2026-06-12","Kimi K2 Thinking":"2025-11-06",
 "GLM-5.2":"2026-06-13","Qwen3.7 Max":"2026-05-19","Qwen3.7 Plus":"2026-06",
 "Qwen3 Coder Plus":"2025-09","Qwen3 Coder 480B A35B":"2025-07-22","Qwen3 Coder Flash":"2025-07-31",
 "Qwen3.6 Max Preview":"2026-04-20","Qwen3.6 27B":"2026-04-22","Qwen3.6 Flash":"2026-04",
 "MiniMax-M3":"2026-06-01","Magistral Medium 2506":"2025-06-08",
}

def primary(s):
    if s is None: return None
    t=str(s).strip()
    if t.lower().startswith("n/a") or t=="—": return None
    m=re.search(r"\d+\.?\d*",t); return float(m.group()) if m else None
PRIM=[[primary(c) for c in r[7]] for r in D]
CMAX=[]
for j in range(12):
    vals=[p[j] for p in PRIM if p[j] is not None]; CMAX.append(max(vals) if vals else None)

def idx(prim, idxs, min_cov, FL=None, clamp=True):
    FL=FL or FLOOR
    num=den=0.0; cov=0
    for j in idxs:
        p=prim[j]
        if p is None or CMAX[j] is None: continue
        rng=CMAX[j]-FL[j]
        if rng<=0: continue
        nb=(p-FL[j])/rng*100.0
        if clamp: nb=max(0.0,nb)
        num+=W[j]*nb; den+=W[j]; cov+=1
    if cov==0: return (None,0,len(idxs),False)
    return (round(num/den,1),cov,len(idxs),cov>=min_cov)
def fmt(t):
    v,cov,tot,ok=t
    if cov==0: return "—"
    return f"{'' if ok else '⚠'}{v} ({cov}/{tot})"
def skey(t):  # 정렬: 정상(ok) > ⚠ > 무데이터, 그 안에서 값 desc
    v,cov,tot,ok=t; tier=2 if ok else (1 if cov>0 else 0); return (tier, v if v is not None else -1)

def build_mx(FL, clamp):
    out=[]
    for r in D:
        p=[primary(c) for c in r[7]]
        out.append({"row":r,"prim":p,
            "cod1":idx(p,COD1,2,FL,clamp),"gen1":idx(p,GEN1,2,FL,clamp),"all1":idx(p,P1,3,FL,clamp),
            "codA":idx(p,CODA,2,FL,clamp),"genA":idx(p,GENA,2,FL,clamp),"allA":idx(p,ALL,3,FL,clamp),
            "cod2":idx(p,COD2,1,FL,clamp),"gen2":idx(p,GEN2,2,FL,clamp),"all2":idx(p,COD2+GEN2,2,FL,clamp)})
    return out
MX = build_mx(FLOOR_HAIKU, True)    # 확정 baseline = Haiku 4.5(+Gemini 2.5 Flash LCB), 클램프 ON

# 미사용 모델: 소스 없는(무데이터) 전부 + 아래 명시
UNUSED_EXPLICIT = {"Qwen3.6 27B", "Kimi K2 Thinking"}
def is_unused(m):
    return (m["allA"][0] is None) or (m["row"][0] in UNUSED_EXPLICIT)
GRAY=PatternFill("solid",fgColor="D9D9D9")

# ===== 성능 5급 매칭 — 사용자 확정 (전체통합 점수 임계값) =====
# Top tier(Fable) / Opus급(5) / Gemini 3.5 Flash급(4) / GPT-5.4급(3) / Sonnet 4.6급(2) / Haiku급(1)
def usertier(v):
    if v is None:   return ("—", None)
    if v >= 95:     return ("Top tier", "X")
    if v >= 78:     return ("Opus급", 5)   # Gemini 3.x Pro(77.0)는 4칸으로
    if v >= 69.5:   return ("Gemini 3.5 Flash급", 4)
    if v >= 58:     return ("GPT-5.4급", 3)
    if v >= 48:     return ("Sonnet 4.6급", 2)
    return ("Haiku급", 1)
def bar(k):
    if k=="X": return "★★★★★"
    if k is None: return ""
    return "■"*k+"□"*(5-k)
KANFILL={"X":"B4A7D6",5:"C6EFCE",4:"D9EAD3",3:"FFF2CC",2:"FCE4D6",1:"F4CCCC"}

# ===== styling =====
wb=openpyxl.Workbook()
HDR=PatternFill("solid",fgColor="1F4E79"); HF=Font(bold=True,color="FFFFFF",size=10)
thin=Side(style="thin",color="BFBFBF"); BD=Border(left=thin,right=thin,top=thin,bottom=thin)
WRAP=Alignment(wrap_text=True,vertical="top"); CTR=Alignment(horizontal="center",vertical="center",wrap_text=True)
COD=PatternFill("solid",fgColor="E2EFDA"); GEN=PatternFill("solid",fgColor="DDEBF7"); ALLF=PatternFill("solid",fgColor="FFF2CC")
COD_D=PatternFill("solid",fgColor="C6E0B4"); GEN_D=PatternFill("solid",fgColor="BDD7EE"); ALL_D=PatternFill("solid",fgColor="FFE699")
BASE=PatternFill("solid",fgColor="FCE4D6"); SEC=PatternFill("solid",fgColor="8EA9DB")
def hrow(ws,r=1):
    for c in ws[r]: c.fill=HDR; c.font=HF; c.alignment=CTR; c.border=BD
def grid(ws,nc,s=2):
    for r in range(s,ws.max_row+1):
        for ci in range(1,nc+1):
            cell=ws.cell(row=r,column=ci); cell.border=BD
            if cell.alignment is None or not cell.alignment.wrap_text: cell.alignment=WRAP

# ===== README =====
ws=wb.active; ws.title="README"
ws.append(["AI Model × Benchmark — 관리표 (2026-06)"]); ws.append([]); ws.append(["항목","내용"])
rd=[
 ("조사 시점","2026-06-27 (team/analyst). 벤치마크는 이 xlsx 단일 관리."),
 ("목적","모델별 '급(tier)' 파악 — baseline(중급 모델) 대비 / 프런티어 대비 위치."),
 ("정규화","baseline-floor min-max: (점수 − floor) / (표내최고 − floor) × 100, 0 미만은 0(클램프). '0 = baseline 수준, 100 = 표내 최고'."),
 ("baseline(floor)","Claude Haiku 4.5 실측(9벤치) + Gemini 2.5 Flash(LiveCodeBench, Haiku 미보유분) — 둘 다 동일 중급 티어. ARC-AGI-2/FrontierMath는 floor=0(중급모델 ≈0이라 무방). Haiku 자신은 0-라인이라 하단에 위치(정상)."),
 ("벤치 구성","1차 8: SWE-bench Pro·Terminal-Bench v2.1·LiveCodeBench·TAU2 / GPQA·HLE·ARC-AGI-2·FrontierMath. 2차 4: MMLU-Pro·AIME·MMMU·OSWorld-Verified."),
 ("제외된 벤치","SWE-bench Live·Aider Polyglot·SWE-Lancer·GAIA·BigCodeBench — 데이터 부재/리더보드 사망으로 계산 제외."),
 ("인덱스","코딩/범용/전체 = 해당 그룹 정규화값 가중평균(가중치=신뢰도×목적적합성). 셀 '(k/n)'=커버리지. 그룹 미달이면 ⚠(값은 표시, 순위 하단)."),
 ("성능급 (확정)","전체(통합) 점수 임계값: ≥95 Top tier(Fable) / ≥77 Opus급(5칸) / ≥69.5 Gemini 3.5 Flash급(4칸) / ≥58 GPT-5.4급(3칸) / ≥48 Sonnet 4.6급(2칸) / 나머지 Haiku급(1칸) / 무데이터 —. 막대 ■=칸수(Top=★). ⚠=저커버리지. ※비용은 혼합$로 별도 5칸 구분 예정."),
 ("⚠ 표기","표본 부족(코딩·범용 2개 미만, 전체 3개 미만)이면 ⚠+값. 정상 정렬에서 빼고 아래로. '—'=데이터 0."),
 ("effort 분리","벤치가 effort/scaffold/tier로 나뉘면 셀에 분리표기(예 GPQA '94.0 xhigh/93.2 high'). 인덱스는 셀 첫 수치(대표값) 사용."),
 ("⚠ SWE-bench Pro","vendor scaffold vs SEAL 표준 혼재 — 같은 척도끼리만 엄밀비교."),
 ("가격","USD/1M tokens. 혼합=(3·In+Out)/4. OR=OpenRouter, API=공식가."),
 ("AA지수통합 탭","Artificial Analysis 3지수(Agentic·Coding·Intelligence, 27 Jun '26) 별도 통합. Fable 5=100·Haiku 4.5=0 정규화 후 3지수 평균. effort 변형은 행 분리. Haiku 미만 제외. 우리 내부 정규화(Leaderboard)와는 출처·척도가 다른 독립 지표."),
 ("리더보드-최종 탭","AA지수통합에서 사용자 확정 23행만. 기존 리더보드 형식에서 '내부 벤치 인덱스 컬럼'만 제거하고 메타데이터(출시일·컨텍스트·입력/출력/혼합$)+성능급+AA점수(통합·AGT·CODE·INT)로 구성. effort 행 분리 유지. 성능막대=0~5 (AA통합 앵커: 5=GPT-5.4 위 / 4=GPT-5.4 / 3=Sonnet max / 2=DeepSeek V4 Pro[Sonnet medium 데이터 없어 대체] / 1=GPT-5.4 mini / 0=Haiku). 막대/OR노출은 복사본 N·P·O열 사용자 수동 확정값 그대로. OR노출 'O'=AgentParty OpenRouter 목록 표시 대상. 비용(1~5,X)=혼합$ 기준 5칸(1=최저렴…5=비쌈, X=최고가) — 성능막대×비용으로 5×5 그리드. DeepSeek V4 Flash는 AA전용이라 메타데이터 공란."),
]
for k,v in rd: ws.append([k,v])
ws["A1"].font=Font(bold=True,size=14,color="1F4E79")
for c in ws[3]: c.fill=HDR; c.font=HF
ws.column_dimensions["A"].width=22; ws.column_dimensions["B"].width=122
for r in range(4,ws.max_row+1):
    ws.cell(row=r,column=1).font=Font(bold=True); ws.cell(row=r,column=1).alignment=WRAP; ws.cell(row=r,column=2).alignment=WRAP

# ===== Leaderboard (1행 통합) — baseline별 재사용. 점수=숫자(정렬가능), 커버리지/⚠ 분리 =====
LOWFONT=Font(color="C00000", bold=True)  # 저커버리지 표시(빨강)
def put_num(ws, rr, ci, t, gfill):
    """index 셀: 숫자값 기입. 저커버리지=빨강폰트, 무데이터=빈칸."""
    v,cov,tot,ok=t
    c=ws.cell(row=rr,column=ci)
    if v is not None:
        c.value=v; c.number_format='0.0'
        if not ok: c.font=LOWFONT
    c.fill=gfill; c.border=BD; c.alignment=CTR
def leaderboard(sheet, mxlist, title):
    ws=wb.create_sheet(sheet)
    ws.append([title]); ws.cell(row=1,column=1).font=Font(bold=True,size=12,color="1F4E79")
    ws.append(["순위","Model","Provider","출시일","컨텍스트","입력$","출력$","혼합$","성능급","칸","성능막대",
               "코딩(1차)","범용(1차)","전체(1차)","코딩(통합)","범용(통합)","전체(통합)","전체커버","사용"])
    for c in ws[2]: c.fill=SEC; c.font=Font(bold=True,color="FFFFFF"); c.alignment=CTR; c.border=BD
    # 미사용은 맨 아래로 (사용=1 먼저), 그 안에서 점수 desc
    for i,m in enumerate(sorted(mxlist,key=lambda m:(0 if is_unused(m) else 1,)+skey(m["allA"]),reverse=True),1):
        row=m["row"]
        av,acov,atot,aok=m["allA"]
        plabel,pk=usertier(av)
        if av is not None and not aok: plabel+=" ⚠"
        unused=is_unused(m)
        ws.append([i,row[0],row[1],REL.get(row[0],"?"),row[5],row[2],row[3],row[4],
                   plabel, (pk if pk is not None else ""), bar(pk), None,None,None,None,None,None,
                   f"{acov}/{atot}" if acov else "—", ("미사용" if unused else "")])
        rr=ws.max_row
        for ci in (6,7,8): ws.cell(row=rr,column=ci).number_format='0.###'  # 입력/출력/혼합 $
        if pk is not None:
            ws.cell(row=rr,column=10).fill=PatternFill("solid",fgColor=KANFILL[pk]); ws.cell(row=rr,column=10).font=Font(bold=True)
        for ci,key,gf in zip((12,13,14,15,16,17),
                             ("cod1","gen1","all1","codA","genA","allA"),
                             (COD,GEN,ALLF,COD_D,GEN_D,ALL_D)):
            put_num(ws,rr,ci,m[key],gf)
        for ci in (1,2,3,4,5,6,7,8,9,10,11,18,19): ws.cell(row=rr,column=ci).border=BD; ws.cell(row=rr,column=ci).alignment=CTR
        if "기준선" in row[0]:
            for ci in (1,2,3,4,5,6,7,8): ws.cell(row=rr,column=ci).fill=BASE
        if unused:  # 회색 + 모델명 취소선
            for ci in range(1,20): ws.cell(row=rr,column=ci).fill=GRAY
            ws.cell(row=rr,column=2).font=Font(strike=True,color="808080")
            ws.cell(row=rr,column=19).font=Font(bold=True,color="C00000")
    ws.freeze_panes="B3"
    for c,w in zip("ABCDEFGHIJKLMNOPQRS",[5,24,10,10,9,7,7,7,12,4,11,9,9,9,9,9,9,8,7]): ws.column_dimensions[c].width=w
leaderboard("Leaderboard", MX, "■ 통합 리더보드 — baseline=Haiku 4.5(+Gemini 2.5 Flash LCB), 클램프 ON. 성능급=전체통합 임계값(확정). 점수=숫자(정렬가능), 빨강=저커버리지")

# ===== bench raw tabs =====
def btab(title,bidx,keys):
    ws=wb.create_sheet(title)
    heads=["#","Model","Provider","출시일","컨텍스트"]+[k[1] for k in keys]+[BNAME[j] for j in bidx]
    ws.append(heads)
    for k,m in enumerate(MX,1):
        row=m["row"]
        ws.append([k,row[0],row[1],REL.get(row[0],"?"),row[5]]+[None for _ in keys]+[row[7][j] for j in bidx])
        rr=ws.max_row
        for off,kk in enumerate(keys):
            put_num(ws,rr,6+off,m[kk[0]],[COD,GEN,ALLF][off])
        if "기준선" in row[0]:
            for ci in (1,2,3,4,5): ws.cell(row=rr,column=ci).fill=BASE
    hrow(ws); ws.freeze_panes="F2"
    ws.column_dimensions["A"].width=4; ws.column_dimensions["B"].width=26
    ws.column_dimensions["C"].width=11; ws.column_dimensions["D"].width=11; ws.column_dimensions["E"].width=9
    nk=len(keys)
    for off in range(nk): ws.column_dimensions[get_column_letter(6+off)].width=13
    for off in range(len(bidx)): ws.column_dimensions[get_column_letter(6+nk+off)].width=30
    grid(ws,len(heads)); ws.row_dimensions[1].height=30
btab("1차 벤치", P1, [("cod1","코딩(1차)"),("gen1","범용(1차)"),("all1","전체(1차)")])
btab("2차 벤치", COD2+GEN2, [("cod2","코딩(2차)"),("gen2","범용(2차)"),("all2","전체(2차)")])

# ===== Benchmark-Info =====
ws=wb.create_sheet("Benchmark-Info")
ws.append(["벤치마크","차수/분류","기준선(floor)","테스트 방식 (How)","측정 축","점수 척도"])
bi=[
 ("SWE-bench Pro","1차/코딩","39.5 (Haiku)","실 엔터프라이즈 GitHub 이슈→패치 생성→숨은 유닛테스트 통과 자동채점. 단발 컨텍스트.","실 저장소 버그수정","해결률 %"),
 ("Terminal-Bench v2.1","1차/코딩","28.3 (Haiku)","89개 사람검증 과업=[지시+Docker+검증+oracle]. 셸 엔드투엔드. 하네스+모델 조합.","셸/DevOps 자동화","성공률 %"),
 ("LiveCodeBench","1차/코딩","71.3 (Gem2.5Flash)","경쟁프로그래밍 신규문제 시간창 수집(오염회피)→테스트 통과.","신규 코딩","pass@1 %"),
 ("TAU2 (Telecom)","1차/코딩·에이전트","83.0 (Haiku)","멀티턴 도구사용 시뮬. 고객응대 에이전트로 정책준수+API 호출.","멀티턴 도구사용","성공률 %"),
 ("GPQA Diamond","1차/범용","73.3 (Haiku)","PhD급 과학 4지선다. 비전문가 ~34%.","전문가급 과학추론","정답률 %"),
 ("HLE","1차/범용","9.7 (Haiku)","전문가 수기 research급 2,500문항. Rolling fork 오염대응.","최난도 전문지식","정답률 %"),
 ("ARC-AGI-2","1차/범용","0 (중급≈0)","격자 변환규칙 소수예시 추론. 암기불가. ARC Prize 검증.","추상 추론·일반화","정답률 %"),
 ("FrontierMath","1차/범용","0 (중급≈0)","Epoch research급 수학 신문제(비공개). Tier1-4. v2(06-12).","research급 수학","정답률 %"),
 ("MMLU-Pro","2차/범용","80.0 (Haiku)","MMLU 강화판(보기10개) 객관식. 포화 진입.","광범위 지식","정답률 %"),
 ("AIME","2차/범용","80.7 (Haiku)","미국 수학경시. 프런티어 100% 포화 다수.","수학 경시","정답률 %"),
 ("MMMU","2차/범용","73.2 (Haiku)","이미지+텍스트 대학과목 멀티모달 객관식.","멀티모달 추론","정답률 %"),
 ("OSWorld-Verified","2차/에이전트","50.7 (Haiku)","실 OS GUI 클릭·입력 과업(컴퓨터-유즈). 2차 중 커버리지 최고.","GUI 컴퓨터-유즈","성공률 %"),
 ("— 제외: SWE-bench Live / Aider Polyglot / SWE-Lancer / GAIA / BigCodeBench","—","—","데이터 부재/리더보드 사망(스크랩불가·미갱신·구세대만)으로 계산에서 제외.","—","—"),
]
for b in bi: ws.append(list(b))
hrow(ws)
for c,w in zip("ABCDEF",[26,16,16,80,20,18]): ws.column_dimensions[c].width=w
for r in range(2,ws.max_row+1): ws.cell(row=r,column=1).font=Font(bold=True); ws.row_dimensions[r].height=52
grid(ws,6)

# ===== Frontier-Anchors =====
ws=wb.create_sheet("Frontier-Anchors")
ws.append(["벤치마크","floor(0%)","표내 최고(100%)","최고 점수","비고"])
an=[
 ("SWE-bench Pro","Haiku 39.5","Claude Fable 5","80.0 (vendor)","가용1위 Opus4.8 69.2 / SEAL표준 GPT-5.4 59.1"),
 ("Terminal-Bench v2.1","Haiku 28.3","GPT-5.5 (Codex CLI)","83.4","Fable5 83.1, Opus4.8 84.6(AA)"),
 ("LiveCodeBench","Gem2.5Flash 71.3","DeepSeek V4 Pro Max","93.5","프런티어 다수 미제출"),
 ("TAU2 (Telecom)","Haiku 83.0","GLM-5.2 (max)","99.1","Grok4.3 97.7"),
 ("GPQA Diamond","Haiku 73.3","GPT-5.4 Pro (xhigh)","94.6","~94% 포화"),
 ("HLE","Haiku 9.7","Claude Fable 5","64.5","tool 유무 편차"),
 ("ARC-AGI-2","0","GPT-5.5 (xhigh)","85.0","중급모델 ≈0이라 floor=0"),
 ("FrontierMath","0","GPT-5.5 Pro (xhigh)","87.7 (T1-3)","중급모델 ≈0이라 floor=0"),
 ("MMLU-Pro","Haiku 80.0","Gemini 3.x Pro","89.8","floor 높음→상단 압축(포화)"),
 ("AIME","Haiku 80.7","(다수 포화)","100","Sonnet 등은 floor 아래→0 클램프 가능"),
 ("MMMU","Haiku 73.2","Gemini 3.1 Flash Lite","73.7","데이터 희소"),
 ("OSWorld-Verified","Haiku 50.7","Claude Fable 5","85.0","Opus4.8 83.4"),
]
for a in an: ws.append(list(a))
hrow(ws)
for c,w in zip("ABCDE",[22,18,24,18,46]): ws.column_dimensions[c].width=w
grid(ws,5)

# ===== Sources =====
ws=wb.create_sheet("Sources")
ws.append(["항목","출처","as-of","메모"])
sr=[
 ("baseline Haiku 4.5","anthropic.com/news/claude-haiku-4-5 · datalearner · AA","2025-10","GPQA73.3·MMLU-Pro80·AIME~80.7·MMMU73.2·TAU2 83·HLE9.7·OSWorld50.7·SWEPro39.5·TBench28.3"),
 ("baseline LiveCodeBench","Gemini 2.5 Flash 71.3 — kilo.ai · DeepMind","2025","Haiku LCB 미보유분 보조(동일 티어)"),
 ("SWE-bench Pro","morphllm · labs.scale.com(SEAL) · benchlm","2026-06","scaffold 비교불가"),
 ("Terminal-Bench v2.1","tbench.ai · AA · benchlm","2026-06","하네스별 상이"),
 ("LiveCodeBench","livecodebench · AA · benchlm","2026-06","프런티어 미제출多"),
 ("TAU2","benchlm(=AA telecom)","2026-06","Telecom 단일도메인"),
 ("GPQA/HLE","AA · lmcouncil · benchlm","2026-06","effort분리"),
 ("ARC-AGI-2/FrontierMath","arcprize · epoch.ai · lmcouncil","2026-06","FM v2(06-12)"),
 ("MMLU-Pro/AIME/MMMU","AA · llm-stats · benchlm","2026-06","신모델 다수 미보고/포화"),
 ("OSWorld-Verified","benchlm · llm-stats","2026-06","두 출처 일치"),
 ("제외 벤치","swe-bench-live · aider.chat · bigcode-bench","2025~26","스크랩불가/미갱신/구세대 → 제외"),
]
for s in sr: ws.append(list(s))
hrow(ws)
for c,w in zip("ABCD",[22,46,12,52]): ws.column_dimensions[c].width=w
grid(ws,4)

# ===== Reasoning/Effort 제어 (모델별, UI 컨트롤용 정밀 스펙 — provider 공식 docs) =====
ws=wb.create_sheet("Reasoning제어")
ws.append(["모델별 추론 제어 — UI 버튼/슬라이더용 정밀 스펙 (2026-06, 공식 docs). '미문서'=공식 미기재(가정 금지)"])
ws.cell(row=1,column=1).font=Font(bold=True,size=12,color="1F4E79")
ws.append(["Model","Provider","제어 타입","파라미터","정확한 선택지 / 범위","기본","thinking OFF","비고 (UI)"])
# 값 = (제어타입, 파라미터, 선택지/범위, 기본, OFF가능, 비고)
RSN={
 "Claude Fable 5":("effort 단계 (thinking 고정ON)","effort · display","effort: low·medium·high·xhigh·max | display: summarized·omitted","effort high · display omitted","불가","thinking 항상 ON — disabled→400. 토글 렌더 금지"),
 "Claude Opus 4.8":("effort 단계 + thinking 토글","effort · thinking","effort: low·medium·high·xhigh·max | thinking: adaptive·disabled","effort high · thinking OFF","가능","budget_tokens 거부(400)"),
 "Claude Opus 4.8 Fast":("effort 단계 + thinking 토글","effort · thinking","effort: low·medium·high·xhigh·max | thinking: adaptive·disabled","effort high · thinking OFF","가능","Opus 4.8과 동일(fast 모드)"),
 "Claude Sonnet 4.6":("effort 단계 + thinking 토글","effort · thinking · (budget_tokens)","effort: low·medium·high·max (xhigh 없음) | thinking: adaptive·disabled","effort high","가능","budget_tokens 1024~max (deprecated, 숨김 권장)"),
 "Claude Haiku 4.5 (기준선)":("thinking 토글 + budget 슬라이더","thinking · budget_tokens","thinking: enabled·disabled | budget_tokens: 1024 ~ (max_tokens−1)","thinking OFF","가능","effort 미지원(렌더 금지) · display 미문서"),
 "GPT-5.5":("effort 단계","reasoning_effort","none·low·medium·high·xhigh","medium","가능(none)","—"),
 "GPT-5.5 Pro":("effort 단계","reasoning_effort","medium·high·xhigh","high","불가","none·low 버튼 금지(API 거부)"),
 "GPT-5.4":("effort 단계","reasoning_effort","none·low·medium·high·xhigh","none","가능(none)","—"),
 "GPT-5.4 Pro":("effort 단계","reasoning_effort","medium·high·xhigh","medium","불가","none·low 버튼 금지"),
 "GPT-5.4 mini":("effort 단계","reasoning_effort","none·low·medium·high·xhigh","none","가능(none)","—"),
 "GPT-5.4 nano":("effort 단계","reasoning_effort","none·low·medium·high·xhigh","none","가능(none)","엣지/임베디드"),
 "GPT-5.3-Codex":("effort 단계","reasoning_effort","low·medium·high·xhigh","미문서","불가","기본 미문서 — effort 명시 전송 권장"),
 "Gemini 3.x Pro":("thinking_level 단계","thinking_level","low·medium·high (minimal 없음)","high","off 레벨 없음(최저 low)","Pro엔 minimal 미지원"),
 "Gemini 3.5 Flash":("thinking_level 단계","thinking_level","minimal·low·medium·high","medium","minimal≈off(보장X)","—"),
 "Gemini 3.1 Flash Lite":("thinking_level 단계","thinking_level","minimal·low·medium·high","minimal","minimal≈off(보장X)","—"),
 "Grok 4.3":("effort 단계","reasoning_effort","none·low·medium·high","low","가능(none)","none=추론 완전 off"),
 "Grok 4.20":("미문서","reasoning_effort(?)","미문서","미문서","미문서","공식 미문서 — 가정 금지"),
 "Grok 4.20 multi-agent":("특수: 에이전트 수","reasoning.effort","low·medium=4 agents / high·xhigh=16 agents","미문서","—","추론깊이 아님! 별도 'Agents 4/16' 컨트롤로"),
 "Grok Build 0.1":("미문서","미문서","미문서","미문서","미문서","코딩 에이전트(베타)"),
 "Kimi K2.6":("thinking 토글","thinking:{type}","enabled·disabled","enabled","가능","—"),
 "Kimi K2.7 Code":("고정 (상시 ON)","thinking(강제)","강제 ON · sampling 잠김(temp 1.0/top_p 0.95)","ON(필수)","불가","토글 렌더 금지"),
 "Kimi K2 Thinking":("고정 (상시 ON)","—","전용 추론 모델","ON","불가","dedicated thinking 모델"),
 "GLM-5.2":("thinking 토글 + effort 단계","reasoning:{enabled} · reasoning_effort","reasoning: true·false | effort: high·max","reasoning ON · effort max","가능","low/medium/off effort 없음"),
 "DeepSeek V4 Pro":("thinking 토글 + effort 단계","thinking:{type} · reasoning_effort","thinking: enabled·disabled | effort: high·max (low/med→high, xhigh→max)","thinking ON · effort high","가능","low·medium 별도 노출 금지(remap). thinking시 temp/top_p 비활성"),
 "Qwen3.7 Max":("thinking 토글 + budget 슬라이더","enable_thinking · thinking_budget","enable_thinking: true·false | budget: ~81920(기본 81920)","thinking ON","가능","budget min/max 미문서 — 콘솔 확인"),
 "Qwen3.7 Plus":("thinking 토글 + budget 슬라이더","enable_thinking · thinking_budget","true·false | budget 기본 81920","thinking ON","가능","budget 범위 미문서"),
 "Qwen3 Coder Plus":("고정 (non-thinking)","—","없음 (추론 안 함)","non-thinking","n/a","thinking 토글 렌더 금지"),
 "Qwen3 Coder 480B A35B":("고정 (non-thinking)","—","없음 (추론 안 함)","non-thinking","n/a","enable_thinking 불필요 — 항상 비추론"),
 "Qwen3 Coder Flash":("고정 (non-thinking)","—","없음 (추론 안 함)","non-thinking","n/a","Coder family 비추론"),
 "Qwen3.6 Max Preview":("thinking 토글 + budget","enable_thinking · thinking_budget","true·false | budget 범위 미문서","thinking ON","가능","—"),
 "Qwen3.6 27B":("thinking 토글","enable_thinking (chat_template_kwargs)","true·false","thinking ON","가능","/think·/no_think 미지원 (Qwen3.6)"),
 "Qwen3.6 Flash":("thinking 토글","enable_thinking","true·false (per-model 미문서)","thinking ON(family)","가능(family)","per-model 스펙 미문서"),
 "MiniMax-M3":("3단 모드","thinking:{type}","enabled·adaptive·disabled","adaptive","가능","on/off 아닌 3-way 세그먼트"),
 "Magistral Medium 2506":("effort 단계 (추론 네이티브)","reasoning_effort","high·none","미문서","none=최소화(하드오프 미문서)","2506 deprecated(2509 후속). 재확인 필요"),
}
for r in D:
    nm,prov=r[0],r[1]
    t=RSN.get(nm,("미조사","?","?","?","?","—"))
    ws.append([nm,prov,*t])
hrow(ws)
for c,w in zip("ABCDEFGH",[26,11,24,24,46,18,12,40]): ws.column_dimensions[c].width=w
ws.freeze_panes="C3"
grid(ws,8,3)

# ===== AA 지수 통합 (Artificial Analysis 3-index, 27 Jun '26) =====
# effort 변형을 행으로 분리. 정규화 = 인덱스별 (s−Haiku)/(Fable−Haiku)×100. Haiku=0·Fable=100.
# 통합 = 모델이 들어있는 인덱스들의 정규화값 평균. 통합<0(Haiku 미만)은 미표시.
def aa_canon(m):
    return {"Claude 5 (with fallback)":"Claude Fable 5",
            "Claude Fable 5 (with fallback)":"Claude Fable 5",
            "Qwen3.1 Max":"Qwen3.7 Max",                 # 사용자: 3.1은 오타, 실제 3.7
            "DeepSeek V4 Pro Max":"DeepSeek V4 Pro (Max)",
            "Grok Build 0.1 0616":"Grok Build 0.1",      # 0616=버전일자
            "Gemini 3.1 Flash-Lite":"Gemini 3.1 Flash Lite"}.get(m.strip(), m.strip())
# (label, score, status) status: ""=정상 / "na"=현재 미가용 / "est"=추정
AA_AGENTIC=[("Claude 5 (with fallback)",52.8,"na"),("Claude Opus 4.8 (max)",47.2,""),("GPT-5.5 (xhigh)",44.9,""),
 ("GPT-5.5 (high)",43.5,""),("GLM-5.2 (max)",43.1,""),("GPT-5.4 (xhigh)",41.1,""),("Claude Sonnet 4.6 (max)",40.8,""),
 ("GPT-5.5 (medium)",37.8,""),("Gemini 3.5 Flash",37.4,""),("DeepSeek V4 Pro Max",36.4,""),("MiniMax-M3",35.4,""),
 ("DeepSeek V4 Flash (Max)",31.1,""),("Qwen3.1 Max",30.6,""),("GPT-5.5 (low)",30.4,""),("Kimi K2.6",30.3,""),
 ("GPT-5.4 mini (xhigh)",30.2,""),("MiMo-V2.5-Pro",29.1,""),("Muse Spark",28.7,""),("Nemotron 3 Ultra",27.4,""),
 ("Grok 4.3 (high)",24.1,""),("Gemini 3.1 Pro Preview",21.4,""),("Qwen3.5 39B A17B",19.8,""),("Mistral Medium 3.5",19,""),
 ("Claude 4.5 Haiku",16.4,""),("Gemma 4 31B",14.4,""),("gpt-oss-120b (high)",13.2,""),("Nova 2.0 Pro Preview (medium)",7,""),
 ("gpt-oss-20B (high)",3.1,""),("Solar Pro 3",2.7,"")]
AA_CODING=[("Claude 5 (with fallback)",76.5,"na"),("GPT-5.5 (xhigh)",74.9,""),("Claude Opus 4.8 (max)",74.3,""),
 ("GPT-5.5 (high)",71.6,""),("GPT-5.5 (medium)",71.5,""),("GPT-5.4 (xhigh)",71.1,""),("Gemini 3.5 Flash",70.1,""),
 ("Gemini 3.1 Pro Preview",68.8,""),("GLM-5.2 (max)",68.8,""),("Qwen3.1 Max",66,""),("Claude Sonnet 4.6 (max)",63,""),
 ("GPT-5.5 (low)",60.9,""),("MiMo-V2.5-Pro",60.2,""),("DeepSeek V4 Pro Max",59.4,""),("Muse Spark",58.6,""),
 ("MiniMax-M3",58.6,""),("DeepSeek V4 Flash (Max)",56.2,""),("GPT-5.4 mini (xhigh)",56.1,""),("Kimi K2.6",56,""),
 ("Nemotron 3 Ultra",49.3,""),("Qwen3.5 39B A17B",48.2,""),("Mistral Medium 3.5",46.9,""),("Claude 4.5 Haiku",43.9,""),
 ("Gemma 4 31B",43.4,""),("Grok 4.3 (high)",42.2,""),("Nova 2.0 Pro Preview (medium)",34,""),("gpt-oss-120b (high)",30.4,""),
 ("K2 Think V2",21,""),("gpt-oss-20B (high)",20.7,""),("Solar Pro 3",16.2,"")]
AA_INTEL=[("Claude Fable 5 (with fallback)",60,"na"),("Claude Opus 4.8 (max)",56,""),("GPT-5.5 (xhigh)",55,""),
 ("GPT-5.5 (high)",53,""),("GPT-5.4 (xhigh)",51,""),("GLM-5.2 (max)",51,""),("GPT-5.5 (medium)",50,""),
 ("Gemini 3.5 Flash",50,""),("Claude Sonnet 4.6 (max)",47,""),("Gemini 3.1 Pro Preview",46,""),("Qwen3.1 Max",46,""),
 ("MiniMax-M3",44,""),("DeepSeek V4 Pro (Max)",44,""),("Codex GPT-5.3 (xhigh)",44,"est"),("GPT-5.5 (low)",43,""),
 ("Muse Spark",43,""),("Kimi K2.6",43,""),("MiMo-V2.5-Pro",42,""),("GPT-5.2 (xhigh)",42,"est"),("DeepSeek V4 Flash (Max)",40,""),
 ("Codex GPT-5.2 (xhigh)",40,"est"),("GPT-5.4 mini (xhigh)",40,""),("GPT-5.4 (low)",39,"est"),("GPT-5.1 (high)",39,"est"),
 ("Nemotron 3 Ultra",38,""),("Grok 4.3 (high)",38,""),("Qwen3.5 39B A17B",34,""),("Mistral Medium 3.5",30,""),
 ("GPT-5.4 mini (medium)",30,"est"),("Claude 4.5 Haiku",30,""),("Gemma 4 31B",29,""),("gpt-oss-120b (high)",24,"")]
# 사용자 보강(AA 미수록): Qwen3.7 Plus — Agentic 20.8 / Coding 55.9 / Intelligence 39
AA_AGENTIC.append(("Qwen3.7 Plus",20.8,"add")); AA_CODING.append(("Qwen3.7 Plus",55.9,"add")); AA_INTEL.append(("Qwen3.7 Plus",39,"add"))
# 사용자 보강 2차(AA 필터링 캡처 27 Jun '26, 우리모델 위주): 누락 모델 6종 추가
AA_AGENTIC += [("Kimi K2.7 Code",29.6,""),("Grok Build 0.1 0616",28.0,""),("GPT-5.4 nano (xhigh)",27.5,""),("Gemini 3.1 Flash-Lite",6.2,"")]
AA_CODING  += [("Kimi K2.7 Code",60.8,""),("GPT-5.4 nano (xhigh)",56.1,""),("Grok Build 0.1 0616",51.5,""),("Gemini 3.1 Flash-Lite",34.7,"")]
AA_INTEL   += [("Kimi K2.7 Code",42,""),("Qwen3.6 Max Preview",40,"est"),("Grok Build 0.1 0616",40,""),("GPT-5.4 nano (xhigh)",38,""),("Kimi K2 Thinking",33,"est"),("Gemini 3.1 Flash-Lite",25,"")]

def aa_build(rows):
    d={}; st={}
    for lab,sc,s in rows:
        c=aa_canon(lab); d[c]=float(sc); st[c]=s
    return d,st
AGD,AGS=aa_build(AA_AGENTIC); COD_,COS=aa_build(AA_CODING); INT_,INS=aa_build(AA_INTEL)
AA_IDX=[("Agentic",AGD,AGS),("Coding",COD_,COS),("Intelligence",INT_,INS)]
AA_FAB="Claude Fable 5"; AA_HAI="Claude 4.5 Haiku"
AA_ANCH={n:(d[AA_FAB],d[AA_HAI]) for n,d,_ in AA_IDX}
def aa_norm(n,s):
    fab,hai=AA_ANCH[n]; return (s-hai)/(fab-hai)*100.0
# AA 라벨 → 우리 리더보드 모델명 (effort 접미사 제거 후 매핑)
AA_OURBASE={"Claude Fable 5":"Claude Fable 5","Claude Opus 4.8":"Claude Opus 4.8","GPT-5.5":"GPT-5.5",
 "GPT-5.4":"GPT-5.4","GLM-5.2":"GLM-5.2","Gemini 3.5 Flash":"Gemini 3.5 Flash","Claude Sonnet 4.6":"Claude Sonnet 4.6",
 "Gemini 3.1 Pro Preview":"Gemini 3.x Pro","Qwen3.7 Max":"Qwen3.7 Max","Qwen3.7 Plus":"Qwen3.7 Plus",
 "DeepSeek V4 Pro":"DeepSeek V4 Pro","MiniMax-M3":"MiniMax-M3","Kimi K2.6":"Kimi K2.6","GPT-5.4 mini":"GPT-5.4 mini",
 "Grok 4.3":"Grok 4.3","Codex GPT-5.3":"GPT-5.3-Codex","Claude 4.5 Haiku":"Claude Haiku 4.5 (기준선)",
 "Kimi K2.7 Code":"Kimi K2.7 Code","Grok Build 0.1":"Grok Build 0.1","GPT-5.4 nano":"GPT-5.4 nano",
 "Gemini 3.1 Flash Lite":"Gemini 3.1 Flash Lite","Qwen3.6 Max Preview":"Qwen3.6 Max Preview","Kimi K2 Thinking":"Kimi K2 Thinking"}
def aa_our(lab):
    base=re.sub(r"\s*\(.*\)\s*$","",lab).strip()
    return AA_OURBASE.get(base,"")
# 통합 계산
aa_models=set();
for _,d,_ in AA_IDX: aa_models|=set(d)
aa_rows=[]
for m in aa_models:
    parts={}; sts=[]
    for n,d,st in AA_IDX:
        if m in d: parts[n]=aa_norm(n,d[m]); sts.append(st[m])
    avg=sum(parts.values())/len(parts)
    sev = "na" if "na" in sts else ("add" if "add" in sts else ("est" if "est" in sts else ""))
    aa_rows.append({"m":m,"avg":avg,"p":parts,"raw":{n:d.get(m) for n,d,_ in AA_IDX},"cov":len(parts),"st":sev,"our":aa_our(m)})
aa_rows=[r for r in aa_rows if r["avg"]>=0]            # Haiku 미만 미표시
aa_rows.sort(key=lambda r:-r["avg"])

ws=wb.create_sheet("AA지수통합")
ws.append(["Artificial Analysis 3-지수 통합 랭킹 (27 Jun '26) — Fable 5=100 / Haiku 4.5=0 정규화 후 3지수 평균. effort 행 분리. Haiku 미만 제외."])
ws.cell(row=1,column=1).font=Font(bold=True,size=12,color="1F4E79")
ws.append(["순위","모델 (effort)","AA통합","Agt원","Cod원","Int원","Agt정규","Cod정규","Int정규","커버","우리 리더보드","비고"])
for c in ws[2]: c.fill=SEC; c.font=Font(bold=True,color="FFFFFF"); c.alignment=CTR; c.border=BD
STMARK={"na":"현재 미가용","est":"추정치","add":"사용자 보강","":""}
AAFILL=PatternFill("solid",fgColor="E4DFEC")
for i,r in enumerate(aa_rows,1):
    raw=r["raw"]; p=r["p"]
    ws.append([i,r["m"],round(r["avg"],1),
               raw["Agentic"],raw["Coding"],raw["Intelligence"],
               (round(p["Agentic"],1) if "Agentic" in p else None),
               (round(p["Coding"],1) if "Coding" in p else None),
               (round(p["Intelligence"],1) if "Intelligence" in p else None),
               f'{r["cov"]}/3', (r["our"] if r["our"] else "— (AA전용)"), STMARK[r["st"]]])
    rr=ws.max_row
    for ci in range(1,13): ws.cell(row=rr,column=ci).border=BD; ws.cell(row=rr,column=ci).alignment=CTR
    ws.cell(row=rr,column=3).number_format='0.0'; ws.cell(row=rr,column=3).font=Font(bold=True); ws.cell(row=rr,column=3).fill=AAFILL
    for ci in (4,5,6,7,8,9): ws.cell(row=rr,column=ci).number_format='0.0'
    for ci in (7,8,9): ws.cell(row=rr,column=ci).fill=ALLF
    if r["m"] in (AA_FAB,AA_HAI):   # 앵커 강조
        for ci in (1,2,3): ws.cell(row=rr,column=ci).fill=BASE
    if not r["our"]:                # AA 전용(우리 미추적) 회색
        ws.cell(row=rr,column=11).font=Font(color="808080")
ws.freeze_panes="C3"
for c,w in zip("ABCDEFGHIJKL",[5,30,9,8,8,8,9,9,9,7,22,12]): ws.column_dimensions[c].width=w

# ===== 리더보드-최종 (AA지수통합 사용자 확정 23행) =====
# 기존 리더보드에서 '내부 벤치 인덱스 컬럼'만 제거, 메타데이터+성능급+AA점수로. effort 행 분리 유지.
FINAL_AA={"Claude Fable 5","Claude Opus 4.8 (max)","GPT-5.5 (xhigh)","GPT-5.5 (high)","GPT-5.4 (xhigh)",
 "GLM-5.2 (max)","GPT-5.5 (medium)","Gemini 3.5 Flash","Claude Sonnet 4.6 (max)","Qwen3.7 Max",
 "DeepSeek V4 Pro (Max)","MiniMax-M3","Gemini 3.1 Pro Preview","GPT-5.5 (low)","Kimi K2.7 Code","Kimi K2.6",
 "DeepSeek V4 Flash (Max)","GPT-5.4 mini (xhigh)","GPT-5.4 nano (xhigh)","Grok Build 0.1","Qwen3.7 Plus",
 "Grok 4.3 (high)","Claude 4.5 Haiku"}
DBYNAME={r[0]:r for r in D}
# 성능막대 0~5 — 사용자가 복사본 N(기준)·P(점수)열에 수동 확정한 배정을 그대로 사용(단일 소스).
AA_BAND_MANUAL={
 "Claude Fable 5":"x",
 "Claude Opus 4.8 (max)":5,"GPT-5.5 (xhigh)":5,"GPT-5.5 (high)":5,
 "GPT-5.4 (xhigh)":4,"GLM-5.2 (max)":4,"GPT-5.5 (medium)":4,"Gemini 3.5 Flash":4,
 "Claude Sonnet 4.6 (max)":3,"Qwen3.7 Max":3,
 "DeepSeek V4 Pro (Max)":2,"MiniMax-M3":2,"Gemini 3.1 Pro Preview":2,
 "GPT-5.5 (low)":1,"Kimi K2.7 Code":1,"Kimi K2.6":1,"DeepSeek V4 Flash (Max)":1,"GPT-5.4 mini (xhigh)":1,
 "GPT-5.4 nano (xhigh)":0,"Grok Build 0.1":0,"Qwen3.7 Plus":0,"Grok 4.3 (high)":0,"Claude 4.5 Haiku":0}
def aa_band(label): return AA_BAND_MANUAL.get(label)
def aa_bar(b):
    if b=="x": return "★★★★★"
    return "" if b is None else "■"*b+"□"*(5-b)
AABANDFILL={"x":"B4A7D6",5:"C6EFCE",4:"D9EAD3",3:"FFF2CC",2:"FCE4D6",1:"F8CBAD",0:"F4CCCC"}
BANDLABEL={"x":"최고 (Fable)",5:"5 · Opus 4.8급",4:"4 · GPT-5.4급",3:"3 · Sonnet max급",
           2:"2 · Sonnet medium급",1:"1 · GPT-5.4 mini급",0:"0 · Haiku급"}
# OpenRouter 노출 여부 — 복사본 O열 그대로. 'O'=AgentParty OpenRouter 목록에 표시할 모델.
AA_OR_SHOWN={"GLM-5.2 (max)","Gemini 3.5 Flash","Qwen3.7 Max","DeepSeek V4 Pro (Max)","MiniMax-M3",
 "Gemini 3.1 Pro Preview","Kimi K2.7 Code","Kimi K2.6","DeepSeek V4 Flash (Max)","Grok Build 0.1",
 "Qwen3.7 Plus","Grok 4.3 (high)"}
ORFILL=PatternFill("solid",fgColor="C6EFCE")
# 비용급 1~5(X=최고) — 복사본/원본 S열 사용자 수동 확정(혼합$ 기준). 1=가장 저렴 … 5=비쌈, X=최고가.
AA_COST_MANUAL={
 "Claude Fable 5":"X",
 "Claude Opus 4.8 (max)":5,"GPT-5.5 (xhigh)":5,"GPT-5.5 (high)":5,"GPT-5.5 (medium)":5,"GPT-5.5 (low)":5,"Claude Sonnet 4.6 (max)":5,
 "GPT-5.4 (xhigh)":4,"Gemini 3.5 Flash":4,"Gemini 3.1 Pro Preview":4,
 "Qwen3.7 Max":3,"GPT-5.4 mini (xhigh)":3,"Grok 4.3 (high)":3,"Claude 4.5 Haiku":3,
 "GLM-5.2 (max)":2,"Kimi K2.7 Code":2,"Kimi K2.6":2,"Grok Build 0.1":2,
 "DeepSeek V4 Pro (Max)":1,"MiniMax-M3":1,"DeepSeek V4 Flash (Max)":1,"GPT-5.4 nano (xhigh)":1,"Qwen3.7 Plus":1}
AACOSTFILL={"X":"D9B3FF",5:"F4CCCC",4:"FCE4D6",3:"FFF2CC",2:"E2EFDA",1:"C6EFCE"}  # 비쌈=red … 저렴=green
ws=wb.create_sheet("리더보드-최종")
ws.append(["■ 리더보드-최종 — AA지수통합(27 Jun '26) 확정 모델만. effort 행 분리. 성능급=AA통합 기준. 메타데이터=기존 리더보드와 동일."])
ws.cell(row=1,column=1).font=Font(bold=True,size=12,color="1F4E79")
ws.append(["순위","Model (effort)","Provider","출시일","컨텍스트","입력$","출력$","혼합$","성능급(0~5)","칸","성능막대","AA통합","AGT","CODE","INT","우리 모델","OR노출","비고","비용(1~5)"])
for c in ws[2]: c.fill=SEC; c.font=Font(bold=True,color="FFFFFF"); c.alignment=CTR; c.border=BD
fin=[r for r in aa_rows if r["m"] in FINAL_AA]
for i,r in enumerate(fin,1):
    av=r["avg"]; pk=aa_band(r["m"]); plabel=BANDLABEL[pk] if pk is not None else "—"; our=r["our"]; d=DBYNAME.get(our); p=r["p"]
    ws.append([i, r["m"], (d[1] if d else ""), (REL.get(our,"?") if our else "?"), (d[5] if d else ""),
               (d[2] if d else None),(d[3] if d else None),(d[4] if d else None),
               plabel,(pk if pk is not None else ""),aa_bar(pk), round(av,1),
               (round(p["Agentic"],1) if "Agentic" in p else None),
               (round(p["Coding"],1) if "Coding" in p else None),
               (round(p["Intelligence"],1) if "Intelligence" in p else None),
               (our if our else "— (AA전용)"),
               ("O" if r["m"] in AA_OR_SHOWN else ""),
               STMARK[r["st"]] or (f'{r["cov"]}/3 커버' if r["cov"]<3 else ""),
               AA_COST_MANUAL.get(r["m"],"")])
    rr=ws.max_row
    for ci in range(1,20): ws.cell(row=rr,column=ci).border=BD; ws.cell(row=rr,column=ci).alignment=CTR
    if r["m"] in AA_OR_SHOWN: ws.cell(row=rr,column=17).fill=ORFILL; ws.cell(row=rr,column=17).font=Font(bold=True,color="375623")
    ck=AA_COST_MANUAL.get(r["m"])
    if ck is not None: ws.cell(row=rr,column=19).fill=PatternFill("solid",fgColor=AACOSTFILL[ck]); ws.cell(row=rr,column=19).font=Font(bold=True)
    for ci in (6,7,8): ws.cell(row=rr,column=ci).number_format='0.###'
    if pk is not None:
        ws.cell(row=rr,column=10).fill=PatternFill("solid",fgColor=AABANDFILL[pk]); ws.cell(row=rr,column=10).font=Font(bold=True)
    ws.cell(row=rr,column=12).number_format='0.0'; ws.cell(row=rr,column=12).font=Font(bold=True); ws.cell(row=rr,column=12).fill=AAFILL
    for ci in (13,14,15): ws.cell(row=rr,column=ci).number_format='0.0'; ws.cell(row=rr,column=ci).fill=ALLF
    if r["m"] in (AA_FAB,AA_HAI):
        for ci in (1,2,12): ws.cell(row=rr,column=ci).fill=BASE
    if not our: ws.cell(row=rr,column=16).font=Font(color="808080")
ws.freeze_panes="C3"
for c,w in zip("ABCDEFGHIJKLMNOPQRS",[5,28,10,10,9,7,7,8,16,4,11,8,7,7,7,22,8,14,9]): ws.column_dimensions[c].width=w

out=os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","docs","model research","AI-Model-Benchmarks-2026.xlsx"))
wb.save(out)
print("saved:",out); print("sheets:",wb.sheetnames); print("models:",len(D),"benches:",12)
