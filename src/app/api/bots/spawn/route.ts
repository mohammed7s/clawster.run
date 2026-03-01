import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { dbRun, dbGet, generateId } from "@/lib/db";
import * as phala from "@/lib/phala";
import * as billing from "@/lib/stripe";
import { deployBot } from "@/lib/deploy";

// ── Billing bypass for testing ──
const BYPASS_BILLING = process.env.BYPASS_BILLING === "true";

export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { name, mode, model, size, telegram_token, api_key, owner_id, soul, openclaw_config, custom_env, workspace_files } = await req.json();

  const isAdvanced = mode === "advanced";

  // ── Validate ──
  if (!name || !/^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$/.test(name)) {
    return NextResponse.json({ error: "Bot name: 2-24 chars, lowercase alphanumeric + hyphens" }, { status: 400 });
  }

  if (isAdvanced) {
    // Advanced mode: openclaw.json is required, individual fields are not
    if (!openclaw_config) return NextResponse.json({ error: "openclaw.json config is required in advanced mode" }, { status: 400 });
  } else {
    // Easy mode: individual fields required
    if (!telegram_token) return NextResponse.json({ error: "Telegram bot token is required" }, { status: 400 });
    if (!api_key) return NextResponse.json({ error: "AI API key is required" }, { status: 400 });
    if (!owner_id) return NextResponse.json({ error: "Telegram owner ID is required" }, { status: 400 });
  }

  const existing = await dbGet(
    "SELECT id, status FROM bots WHERE user_id = ? AND name = ?",
    user.id, name
  );
  if (existing) {
    const existingStatus = (existing as any).status;
    // Allow reuse if terminated or stuck in pending_payment (stale checkout)
    if (existingStatus === "terminated" || existingStatus === "pending_payment") {
      await dbRun("DELETE FROM bots WHERE id = ?", (existing as any).id);
    } else {
      return NextResponse.json({ error: "Bot name already in use" }, { status: 409 });
    }
  }

  const botId = generateId();
  const instanceSize = ["small", "medium"].includes(size) ? size : "small";
  const botModel = isAdvanced ? (model || "custom") : (model || "anthropic/claude-sonnet-4-20250514");

  // ── Save bot + secrets as pending ──
  // Validate custom config if provided
  if (openclaw_config) {
    try { JSON.parse(openclaw_config); } catch {
      return NextResponse.json({ error: "openclaw_config must be valid JSON" }, { status: 400 });
    }
  }

  // Validate custom_env if provided (expects array of {key, value})
  if (custom_env && !Array.isArray(custom_env)) {
    return NextResponse.json({ error: "custom_env must be an array of {key, value}" }, { status: 400 });
  }

  await dbRun(
    `INSERT INTO bots (id, user_id, name, model, instance_size, status, pending_telegram_token, pending_api_key, pending_owner_id, pending_soul, pending_openclaw_config, pending_custom_env, pending_workspace_files)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    botId, user.id, name, botModel, instanceSize,
    BYPASS_BILLING ? "provisioning" : "pending_payment",
    telegram_token || null, api_key || null, owner_id ? String(owner_id) : null, soul || null,
    openclaw_config || null,
    custom_env ? JSON.stringify(custom_env) : null,
    workspace_files ? JSON.stringify(workspace_files) : null
  );

  // ── BYPASS: skip billing, deploy directly ──
  if (BYPASS_BILLING) {
    const result = await deployBot(botId);
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    return NextResponse.json({
      bot_id: botId, name, status: "starting", ...result,
    }, { status: 201 });
  }

  // ── Create Stripe Checkout ──
  const origin = req.headers.get("origin") || "https://clawster.run";
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    customerId = await billing.ensureCustomer(user.id, user.email);
    await dbRun("UPDATE users SET stripe_customer_id = ?, updated_at = datetime('now') WHERE id = ?", customerId, user.id);
  }

  const sizeConfig = phala.getSize(instanceSize);
  const checkoutUrl = await billing.createBotCheckout(
    customerId,
    botId,
    instanceSize,
    sizeConfig.retailPerHour,
    `${origin}/dashboard?billing=success&bot=${botId}`,
    `${origin}/dashboard?billing=cancelled&bot=${botId}`
  );

  return NextResponse.json({
    bot_id: botId, name, status: "pending_payment", checkout_url: checkoutUrl,
  }, { status: 201 });
}
