type ColumnValue = { id: string; text: string | null; value: string | null };
type MondayItem = { id: string; name: string; column_values: ColumnValue[] };
type MondayPage = { cursor: string | null; items: MondayItem[] };

type MondayResponse<T> = { data?: T; errors?: Array<{ message?: string }> };

type Activity = {
  email: string;
  date: string;
  type: string;
  description: string;
  itemName: string;
};

type ScoredActivity = Activity & { discountPercent: number; reason: string; needsReview: boolean };

type MemberSummary = {
  email: string;
  activities: ScoredActivity[];
  discountPercent: number;
  outputAmount: number;
  text: string;
};

const MONDAY_API_URL = "https://api.monday.com/v2";
const MAX_MONTHLY_DISCOUNT_PERCENT = 75;

// Wrangler generates Env from wrangler.jsonc. Secrets are intentionally absent
// from that file, so this is the one additional runtime binding.
type RuntimeEnv = Env & {
  MONDAY_API_TOKEN: string;
  MANUAL_RUN_TOKEN: string;
};

class MondayClient {
  constructor(private readonly token: string) {}

  async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(MONDAY_API_URL, {
      method: "POST",
      headers: {
        Authorization: this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`monday.com request failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as MondayResponse<T>;
    if (payload.errors?.length || !payload.data) {
      throw new Error(payload.errors?.map((error) => error.message ?? "Unknown GraphQL error").join("; ") ?? "monday.com returned no data");
    }
    return payload.data;
  }

  async getAllItems(boardId: string, columnIds: string[]): Promise<MondayItem[]> {
    const firstPageQuery = `query GetBoardItems($boardId: [ID!], $columnIds: [String!]) {
      boards(ids: $boardId) {
        items_page(limit: 500) {
          cursor
          items { id name column_values(ids: $columnIds) { id text value } }
        }
      }
    }`;
    const initial = await this.request<{ boards: Array<{ items_page: MondayPage }> }>(firstPageQuery, { boardId: [boardId], columnIds });
    const items = [...(initial.boards[0]?.items_page.items ?? [])];
    let cursor = initial.boards[0]?.items_page.cursor ?? null;
    const nextPageQuery = `query NextBoardItems($cursor: String!) {
      next_items_page(limit: 500, cursor: $cursor) {
        cursor
        items { id name column_values { id text value } }
      }
    }`;

    while (cursor) {
      const next = await this.request<{ next_items_page: MondayPage }>(nextPageQuery, { cursor });
      items.push(...next.next_items_page.items);
      cursor = next.next_items_page.cursor;
    }
    return items;
  }

  async upsertSummary(boardId: string, existingItemId: string | undefined, itemName: string, columnValues: Record<string, unknown>): Promise<void> {
    if (existingItemId) {
      const update = `mutation UpdateSummary($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
      }`;
      await this.request(update, { boardId, itemId: existingItemId, columnValues: JSON.stringify(columnValues) });
      return;
    }

    const create = `mutation CreateSummary($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id }
    }`;
    await this.request(create, { boardId, itemName, columnValues: JSON.stringify(columnValues) });
  }
}

function column(item: MondayItem, id: string): ColumnValue | undefined {
  return item.column_values.find((entry) => entry.id === id);
}

function text(item: MondayItem, id: string): string {
  return column(item, id)?.text?.trim() ?? "";
}

function csv(value: string): Set<string> {
  return new Set(value.split(",").map((entry) => entry.trim().toLocaleLowerCase()).filter(Boolean));
}

function emailFromColumn(item: MondayItem, id: string): string {
  const entry = column(item, id);
  if (!entry) return "";
  if (entry.value) {
    try {
      const parsed = JSON.parse(entry.value) as { email?: unknown };
      if (typeof parsed.email === "string" && parsed.email) return parsed.email.trim().toLocaleLowerCase();
    } catch {
      // Text is a safe fallback for a malformed email-column value.
    }
  }
  const match = entry.text?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLocaleLowerCase() ?? "";
}

function isoDate(item: MondayItem, id: string): string {
  const entry = column(item, id);
  if (!entry) return "";
  if (entry.value) {
    try {
      const parsed = JSON.parse(entry.value) as { date?: unknown };
      if (typeof parsed.date === "string") return parsed.date;
    } catch {
      // Fall through to the human-readable date text.
    }
  }
  const match = entry.text?.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? "";
}

function previousMonth(reference: Date): string {
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

function dashboardHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CoLab Work-Trade Summary</title><style>
    :root{font-family:ui-sans-serif,system-ui,sans-serif;color:#17221a;background:#f7f5ef}body{display:grid;place-items:center;min-height:100vh;margin:0;padding:1.5rem;box-sizing:border-box}main{width:min(100%,34rem);padding:2rem;border:1px solid #d8d4c8;border-radius:1rem;background:#fffefa;box-shadow:0 1rem 3rem #453d2714}h1{margin:0 0 .5rem;font-size:1.65rem}p{line-height:1.5;color:#4b554b}label{display:grid;gap:.4rem;margin:1.15rem 0;font-weight:650}input{padding:.7rem .8rem;border:1px solid #b9b8ad;border-radius:.5rem;font:inherit;background:white}button{width:100%;padding:.8rem 1rem;border:0;border-radius:.5rem;color:white;background:#246947;font:inherit;font-weight:700;cursor:pointer}button:disabled{cursor:wait;opacity:.65}#result{min-height:1.5rem;margin:1rem 0 0;font-weight:600}.hint{font-size:.88rem}
  </style></head><body><main><h1>CoLab work-trade summary</h1><p>Run a monthly activity summary now. Existing summaries for the same member and month are updated rather than duplicated.</p><form id="run-form"><label>Month to summarize <input id="month" type="month" required></label><label>Manual run key <input id="token" type="password" autocomplete="current-password" required></label><p class="hint">This is the <code>MANUAL_RUN_TOKEN</code> Worker secret. The page does not save it.</p><button id="run-button" type="submit">Run summary</button></form><p id="result" role="status" aria-live="polite"></p></main><script>
    const month=document.querySelector('#month');const now=new Date();month.value=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString().slice(0,7);document.querySelector('#run-form').addEventListener('submit',async event=>{event.preventDefault();const token=document.querySelector('#token').value;const button=document.querySelector('#run-button');const result=document.querySelector('#result');button.disabled=true;result.textContent='Running summary…';try{const response=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({month:month.value})});const body=await response.json();if(!response.ok)throw new Error(body.error||'The run could not be started.');result.textContent='Complete: '+body.activities+' activities across '+body.members+' members for '+body.month+'.'}catch(error){result.textContent=error instanceof Error?error.message:'The run could not be started.'}finally{button.disabled=false}});
  </script></body></html>`;
}

async function tokenMatches(expected: string, supplied: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const expectedBytes = new Uint8Array(expectedHash);
  const suppliedBytes = new Uint8Array(suppliedHash);
  let difference = expectedBytes.length ^ suppliedBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) difference |= expectedBytes[index] ^ suppliedBytes[index];
  return difference === 0;
}

function requestedMonth(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

function scoreActivity(activity: Activity): ScoredActivity {
  const activityType = activity.type.toLocaleLowerCase();
  const detail = `${activity.itemName} ${activity.description}`.toLocaleLowerCase();

  if (/plan.*community event|host.*community event|coordinat.*collaboration/.test(detail)) return { ...activity, discountPercent: 75, reason: "community event or artist collaboration", needsReview: false };
  if (/grant writ|set.?up|break.?down|exhibition|pop.?up/.test(detail)) return { ...activity, discountPercent: 50, reason: "event support or grant writing", needsReview: false };
  if (/host.*studio hour|programming idea|develop.*program/.test(detail)) return { ...activity, discountPercent: 25, reason: "studio-hours hosting or programming", needsReview: false };
  if (/inventory|totally tea|fill.*ship.*order/.test(detail)) return { ...activity, discountPercent: 20, reason: "retail operations or inventory", needsReview: false };
  if (/quarterly sticker|sticker pack/.test(detail)) return { ...activity, discountPercent: 15, reason: "member-reward fulfillment", needsReview: false };
  if (/make.*graphic|graphic|design/.test(detail)) return { ...activity, discountPercent: 10, reason: "event graphic or design", needsReview: false };
  if (/social media|promot/.test(detail)) return { ...activity, discountPercent: 5, reason: "marketing or outreach", needsReview: false };
  if (["mopped/sweeped", "cleaned tables", "reset entry table", "took out trash", "organized(specify below)"].includes(activityType)) {
    return { ...activity, discountPercent: 10, reason: "CoLab space maintenance", needsReview: false };
  }
  if (["new tool announcement", "opportunities", "member announcement"].includes(activityType)) {
    return { ...activity, discountPercent: 5, reason: "community outreach", needsReview: false };
  }
  if (activityType === "guest pass" || activityType === "check in") return { ...activity, discountPercent: 0, reason: "not a work-trade contribution", needsReview: false };
  return { ...activity, discountPercent: 0, reason: "unmapped activity; manual review needed", needsReview: true };
}

function outputAmount(percent: number, env: RuntimeEnv): number {
  if ((env.DISCOUNT_OUTPUT_MODE as string) !== "dollars") return percent;
  const membershipPrice = Number(env.MEMBERSHIP_MONTHLY_PRICE);
  if (!Number.isFinite(membershipPrice) || membershipPrice <= 10) {
    throw new Error("MEMBERSHIP_MONTHLY_PRICE must be greater than 10 when DISCOUNT_OUTPUT_MODE is dollars");
  }
  return Math.round(Math.min(membershipPrice * (percent / 100), membershipPrice - 10) * 100) / 100;
}

function buildSummary(email: string, activities: Activity[], env: RuntimeEnv): MemberSummary {
  const scored = activities.map(scoreActivity);
  const discountPercent = Math.min(MAX_MONTHLY_DISCOUNT_PERCENT, scored.reduce((total, activity) => total + activity.discountPercent, 0));
  const recommendation = (env.DISCOUNT_OUTPUT_MODE as string) === "dollars"
    ? `$${outputAmount(discountPercent, env).toFixed(2)} discount (keeps at least $10 due)`
    : `${discountPercent}% discount`;
  const lines = scored.map((activity) => `• ${activity.date}: ${activity.type || activity.itemName} — ${activity.reason}${activity.description ? ` (${activity.description})` : ""}`);
  const reviewNote = scored.some((activity) => activity.needsReview) ? " Manual review is needed for unmapped activities." : "";
  return {
    email,
    activities: scored,
    discountPercent,
    outputAmount: outputAmount(discountPercent, env),
    text: `${scored.length} logged member ${scored.length === 1 ? "activity" : "activities"} for this month. Recommended: ${recommendation}.${reviewNote}\n${lines.join("\n")}`,
  };
}

async function summarizeMonth(env: RuntimeEnv, month: string): Promise<{ members: number; activities: number }> {
  const client = new MondayClient(env.MONDAY_API_TOKEN);
  const activityColumns = [
    env.ACTIVITY_MEMBER_EMAIL_COLUMN, env.ACTIVITY_FALLBACK_EMAIL_COLUMN, env.ACTIVITY_MEMBER_FLAG_COLUMN,
    env.ACTIVITY_TYPE_COLUMN, env.ACTIVITY_DESCRIPTION_COLUMN, env.ACTIVITY_DATE_COLUMN, env.ACTIVITY_STATUS_COLUMN,
  ];
  const activityItems = await client.getAllItems(env.ACTIVITY_BOARD_ID, activityColumns);
  const memberLabels = csv(env.MEMBER_YES_LABELS);
  const approvedStatuses = csv(env.APPROVED_STATUS_LABELS);
  const byEmail = new Map<string, Activity[]>();

  for (const item of activityItems) {
    const isMember = memberLabels.has(text(item, env.ACTIVITY_MEMBER_FLAG_COLUMN).toLocaleLowerCase());
    const status = text(item, env.ACTIVITY_STATUS_COLUMN).toLocaleLowerCase();
    const isApproved = approvedStatuses.size === 0 || approvedStatuses.has(status);
    const date = isoDate(item, env.ACTIVITY_DATE_COLUMN);
    const email = emailFromColumn(item, env.ACTIVITY_MEMBER_EMAIL_COLUMN) || emailFromColumn(item, env.ACTIVITY_FALLBACK_EMAIL_COLUMN);
    if (!isMember || !isApproved || !email || !date.startsWith(month)) continue;

    const activity: Activity = { email, date, type: text(item, env.ACTIVITY_TYPE_COLUMN), description: text(item, env.ACTIVITY_DESCRIPTION_COLUMN), itemName: item.name };
    byEmail.set(email, [...(byEmail.get(email) ?? []), activity]);
  }

  const summaryColumns = [env.SUMMARY_EMAIL_COLUMN, env.SUMMARY_DATE_COLUMN];
  const summaryItems = await client.getAllItems(env.SUMMARY_BOARD_ID, summaryColumns);
  const existingByKey = new Map(summaryItems.map((item) => [`${emailFromColumn(item, env.SUMMARY_EMAIL_COLUMN)}|${isoDate(item, env.SUMMARY_DATE_COLUMN).slice(0, 7)}`, item.id]));

  for (const [email, activities] of byEmail) {
    const summary = buildSummary(email, activities.sort((left, right) => left.date.localeCompare(right.date)), env);
    await client.upsertSummary(env.SUMMARY_BOARD_ID, existingByKey.get(`${email}|${month}`), `${email} — ${month} work-trade summary`, {
      [env.SUMMARY_DATE_COLUMN]: { date: `${month}-01` },
      [env.SUMMARY_DISCOUNT_COLUMN]: summary.outputAmount,
      [env.SUMMARY_TEXT_COLUMN]: summary.text,
      [env.SUMMARY_EMAIL_COLUMN]: email,
    });
  }
  return { members: byEmail.size, activities: [...byEmail.values()].reduce((total, activities) => total + activities.length, 0) };
}

export { buildSummary, previousMonth, scoreActivity, summarizeMonth };

export default {
  async scheduled(_event, env, ctx): Promise<void> {
    const month = previousMonth(new Date());
    ctx.waitUntil(summarizeMonth(env, month).then((result) => console.log(JSON.stringify({ event: "monthly_summary_completed", month, ...result }))));
  },
  async fetch(request, env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/") {
      return new Response(dashboardHtml(), { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && path === "/api/run") {
      const authorization = request.headers.get("Authorization") ?? "";
      const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!env.MANUAL_RUN_TOKEN || !(await tokenMatches(env.MANUAL_RUN_TOKEN, suppliedToken))) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
      }
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ error: "A valid JSON body is required." }, { status: 400 }); }
      const month = requestedMonth(body && typeof body === "object" ? (body as { month?: unknown }).month : undefined);
      if (!month) return Response.json({ error: "month must use YYYY-MM." }, { status: 400 });
      try {
        const result = await summarizeMonth(env, month);
        console.log(JSON.stringify({ event: "manual_summary_completed", month, ...result }));
        return Response.json({ month, ...result }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error(JSON.stringify({ event: "manual_summary_failed", month, error: error instanceof Error ? error.message : "Unknown error" }));
        return Response.json({ error: "The summary run failed. Check the Worker logs for details." }, { status: 500, headers: { "Cache-Control": "no-store" } });
      }
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<RuntimeEnv>;
