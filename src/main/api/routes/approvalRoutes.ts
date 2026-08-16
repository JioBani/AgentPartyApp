import { ApiError, required, text, type MethodRoute } from "../methodRegistry";

/**
 * Answering an approval by its own id — the path a phone takes out of a push
 * notification. See `src/shared/approvals.ts` for why the session-scoped
 * `session.approve` cannot serve that case.
 *
 * The desktop UI keeps using `session.approve`: it has the session in hand, and
 * the approval card it clicks belongs to a session it is already rendering.
 */
export const approvalRoutes: MethodRoute[] = [
  {
    /**
     * What is waiting for an answer right now.
     *
     * Exists for a client that was not connected when the approval was raised:
     * once it falls out of the event ring buffer there is no other way to learn
     * of it, so without this a phone could answer only approvals it happened to
     * be online for.
     */
    name: "approval.list",
    http: "GET /api/approvals",
    handler: async (p, ctx) => {
      // Read BEFORE the listing, never after. The listing lands somewhere
      // inside the await; a seq taken afterwards would make the phone skip
      // approval events this answer does not contain — loss, not duplication.
      const seq = ctx.currentSeq?.();
      const listed = await ctx.controller.listPendingApprovals(
        p.workspacePath === undefined ? undefined : text(p.workspacePath),
      );
      return seq === undefined ? listed : { ...listed, seq };
    },
  },
  {
    name: "approval.respond",
    http: "POST /api/approvals/:id/respond",
    handler: (p, ctx) => {
      const behavior = text(p.behavior);
      if (behavior !== "allow" && behavior !== "deny") {
        // A missing or misspelled decision must not be coerced: defaulting to
        // either one answers a security prompt on the user's behalf.
        throw new ApiError(400, "'behavior' must be 'allow' or 'deny'.");
      }
      return ctx.controller.respondToApproval(required(p.id, "id"), behavior, p.updatedInput, p.message);
    },
  },
];
