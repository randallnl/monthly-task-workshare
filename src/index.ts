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
type RuntimeEnv = Env & { MONDAY_API_TOKEN: string };

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
  async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname === "/") return Response.json({ service: "colab-monthly-worktrade-summary", schedule: "monthly" });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<RuntimeEnv>;
