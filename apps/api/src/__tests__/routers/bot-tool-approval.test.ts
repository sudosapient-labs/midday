import { expect, mock, test } from "bun:test";
import { isCancelledTask, isWriteToolName } from "../../bot/action-intent";
import { guardBotTools, type PendingBotAction } from "../../bot/tool-approval";

function fixture() {
  let pending: PendingBotAction[] = [];
  const execute = mock(async () => ({ success: true }));
  const beforeExecute = mock(async () => {});
  const tools: any = {
    transactions_create_bulk: { execute },
    transactions_delete: { execute },
    transactions_list: { execute },
  };
  return {
    execute,
    beforeExecute,
    get pending() {
      return pending;
    },
    delivered() {
      pending = pending.map((action) => ({
        ...action,
        previewDelivered: true,
      }));
    },
    guard(userText: string) {
      return guardBotTools(tools, {
        userText,
        pending,
        beforeExecute,
        persist: async (next) => {
          pending = next;
        },
      }) as any;
    },
  };
}

test("writes are previews until a delivered preview is explicitly confirmed", async () => {
  const f = fixture();
  const input = { transactions: [{ amount: 55, name: "water" }] };
  const preview = await f
    .guard("save water expense")
    .transactions_create_bulk.execute(input, {});
  expect(preview.status).toBe("pending_approval");
  expect(f.execute).not.toHaveBeenCalled();
  await f.guard("yes").transactions_create_bulk.execute(input, {});
  expect(f.execute).not.toHaveBeenCalled();
  f.delivered();
  const confirmed = f.guard("yes, save them");
  await confirmed.transactions_create_bulk.execute(input, {});
  await confirmed.transactions_create_bulk.execute(input, {});
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.beforeExecute).toHaveBeenCalledTimes(1);
  expect(f.pending).toEqual([]);
});

test("confirmation cannot authorize changed arguments or a different operation", async () => {
  const f = fixture();
  await f
    .guard("save expense")
    .transactions_create_bulk.execute({ amount: 0.55 }, {});
  f.delivered();
  await f.guard("yes").transactions_create_bulk.execute({ amount: 55 }, {});
  await f.guard("yes").transactions_delete.execute({ id: "other" }, {});
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.pending[0]?.input).toEqual({ amount: 55 });
});

test("cancellation blocks execution even with a previously approved operation", async () => {
  const f = fixture();
  await f
    .guard("delete transaction")
    .transactions_delete.execute({ id: "old" }, {});
  f.delivered();
  const result = await f
    .guard("never mind, don't delete them")
    .transactions_delete.execute({ id: "old" }, {});
  expect(result.status).toBe("cancelled");
  expect(f.execute).not.toHaveBeenCalled();
  expect(isCancelledTask("stop my timer")).toBe(false);
});

test("failed writes consume approval before execution so a second yes cannot replay", async () => {
  const f = fixture();
  await f
    .guard("save expense")
    .transactions_create_bulk.execute({ amount: 55 }, {});
  f.delivered();
  f.execute.mockImplementationOnce(async () => {
    throw new Error("uncertain write");
  });
  await expect(
    f.guard("yes").transactions_create_bulk.execute({ amount: 55 }, {}),
  ).rejects.toThrow("uncertain write");
  await f.guard("yes").transactions_create_bulk.execute({ amount: 55 }, {});
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test("read tools execute without confirmation", async () => {
  const f = fixture();
  await f.guard("show transactions").transactions_list.execute({}, {});
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.beforeExecute).not.toHaveBeenCalled();
});

test("concurrent duplicate calls cannot execute the same approved write twice", async () => {
  const f = fixture();
  await f
    .guard("save expense")
    .transactions_create_bulk.execute({ amount: 55 }, {});
  f.delivered();
  const confirmed = f.guard("yes");
  await Promise.all([
    confirmed.transactions_create_bulk.execute({ amount: 55 }, {}),
    confirmed.transactions_create_bulk.execute({ amount: 55 }, {}),
  ]);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test("changing a preview invalidates its previous approval within the same turn", async () => {
  const f = fixture();
  await f
    .guard("save expense")
    .transactions_create_bulk.execute({ amount: 0.55 }, {});
  f.delivered();
  const confirmed = f.guard("yes");
  await confirmed.transactions_create_bulk.execute({ amount: 55 }, {});
  await confirmed.transactions_create_bulk.execute({ amount: 0.55 }, {});
  expect(f.execute).not.toHaveBeenCalled();
});

test("payment, invoice, tag mutations and unknown operations require approval", () => {
  for (const name of [
    "invoices_mark_paid",
    "invoices_cancel",
    "invoices_remind",
    "document_tags_assign",
    "document_tags_unassign",
    "future_operation",
  ])
    expect(isWriteToolName(name)).toBe(true);
  expect(isWriteToolName("export_job_status")).toBe(false);
  expect(isCancelledTask("cancel invoice 123")).toBe(false);
});
