/**
 * 受講者のアクション（講義視聴完了・ワーク提出・チェックイン）を
 * Database Webhook 経由で受け取り、LINE に通知する Edge Function。
 *
 * 秘密情報は Supabase の「Project Settings → Edge Functions → Secrets」で設定します。
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const LINE_TO_USER_ID = Deno.env.get("LINE_TO_USER_ID") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
/** "true" のとき、同日チェックインの「更新」でも通知する（省略時は初回登録のみ） */
const CHECKIN_NOTIFY_ON_UPDATE =
  (Deno.env.get("CHECKIN_NOTIFY_ON_UPDATE") ?? "").toLowerCase() === "true";

type WebhookPayload = {
  type?: string;
  table?: string;
  schema?: string;
  record?: Record<string, unknown>;
  old_record?: Record<string, unknown> | null;
};

async function linePush(text: string): Promise<{ ok: boolean; detail?: string }> {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_TO_USER_ID) {
    return { ok: false, detail: "LINE_CHANNEL_ACCESS_TOKEN or LINE_TO_USER_ID missing" };
  }
  const body = {
    to: LINE_TO_USER_ID,
    messages: [{ type: "text", text: text.slice(0, 4500) }],
  };
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, detail: `LINE API ${res.status}: ${t}` };
  }
  return { ok: true };
}

async function resolveMemberLabel(
  sb: ReturnType<typeof createClient>,
  userId: string,
): Promise<string> {
  const { data: profile } = await sb.from("profiles").select("email, name").eq("id", userId).maybeSingle();
  if (profile?.email) {
    const n = (profile.name as string | null)?.trim();
    return n ? `${n}（${profile.email}）` : String(profile.email);
  }
  const { data: userData, error } = await sb.auth.admin.getUserById(userId);
  if (error || !userData?.user?.email) return `ユーザーID: ${userId}`;
  return userData.user.email;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }

  const secret = req.headers.get("x-webhook-secret") ?? "";
  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = (await req.json()) as WebhookPayload;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  const table = payload.table;
  const type = (payload.type ?? "").toUpperCase();
  const record = payload.record;

  if (!table || !record || typeof record.user_id !== "string") {
    return new Response(JSON.stringify({ error: "bad payload", table, hasRecord: !!record }), {
      status: 400,
    });
  }

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "server misconfigured: supabase keys" }), {
      status: 500,
    });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const userId = record.user_id as string;

  if (table === "lecture_views") {
    if (type !== "INSERT") {
      return new Response(JSON.stringify({ skipped: true, reason: "lecture_views only on INSERT" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const label = await resolveMemberLabel(sb, userId);
    const lectureId = String(record.lecture_id ?? "");
    const lineRes = await linePush(`【リリー】講義を視聴完了しました\n${label}\n講義ID: ${lectureId}`);
    return new Response(JSON.stringify({ ok: true, line: lineRes }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (table === "work_answers") {
    if (type !== "INSERT" && type !== "UPDATE") {
      return new Response(JSON.stringify({ skipped: true, reason: "work_answers insert/update only" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const label = await resolveMemberLabel(sb, userId);
    const lectureId = String(record.lecture_id ?? "");
    const actionLabel = type === "INSERT" ? "ワークを提出しました" : "ワークの内容を更新しました";
    const lineRes = await linePush(`【リリー】${actionLabel}\n${label}\n講義ID: ${lectureId}`);
    return new Response(JSON.stringify({ ok: true, line: lineRes }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (table === "checkins") {
    if (type === "UPDATE" && !CHECKIN_NOTIFY_ON_UPDATE) {
      return new Response(JSON.stringify({ skipped: true, reason: "checkin UPDATE skipped (set CHECKIN_NOTIFY_ON_UPDATE=true to enable)" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (type !== "INSERT" && type !== "UPDATE") {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const label = await resolveMemberLabel(sb, userId);
    const date = String(record.date ?? "");
    const mood = record.mood ?? "";
    const action = record.action ?? "";
    const state = record.state ?? "";
    const actionJa = type === "INSERT" ? "日報（チェックイン）を登録しました" : "日報（チェックイン）を更新しました";
    const lineRes = await linePush(
      `【リリー】${actionJa}\n${label}\n日付: ${date}\n気分/行動/状態: ${mood} / ${action} / ${state}`,
    );
    return new Response(JSON.stringify({ ok: true, line: lineRes }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ skipped: true, reason: "table not handled", table }), {
    headers: { "Content-Type": "application/json" },
  });
});
