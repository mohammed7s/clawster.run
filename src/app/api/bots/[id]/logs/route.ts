import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { dbGet } from "@/lib/db";

const PHALA_API = "https://cloud-api.phala.network/api/v1";

function phalaHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-API-Key": process.env.PHALA_API_KEY || "",
    "X-Phala-Version": "2025-10-28",
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;
  const bot = await dbGet<Record<string, unknown>>("SELECT * FROM bots WHERE id = ? AND user_id = ?", id, user.id);
  if (!bot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!bot.phala_cvm_id) return NextResponse.json({ error: "No CVM deployed" }, { status: 400 });

  const tail = parseInt(req.nextUrl.searchParams.get("tail") || "100");
  const cvmId = bot.phala_cvm_id as string;

  try {
    // Step 1: Get composition to find container log endpoint
    const compRes = await fetch(`${PHALA_API}/cvms/${cvmId}/composition`, {
      headers: phalaHeaders(),
    });

    if (compRes.ok) {
      const comp = await compRes.json();
      const containers = comp.containers || [];
      const container = containers.find((c: { log_endpoint?: string }) => c.log_endpoint);

      if (container?.log_endpoint) {
        // Step 2: Fetch container logs from the syslog endpoint
        const logUrl = `${container.log_endpoint}?tail=${Math.min(tail, 500)}&text&bare`;
        const logRes = await fetch(logUrl);

        if (logRes.ok) {
          const rawLogs = await logRes.text();
          const filtered = filterSecrets(rawLogs);
          return NextResponse.json({
            logs: filtered,
            line_count: filtered.split("\n").filter(Boolean).length,
            source: "container",
          });
        }
      }
    }

    // Fallback: Try serial logs via syslog endpoint
    const infoRes = await fetch(`${PHALA_API}/cvms/${cvmId}`, {
      headers: phalaHeaders(),
    });

    if (infoRes.ok) {
      const info = await infoRes.json();
      if (info.syslog_endpoint) {
        const serialUrl = `${info.syslog_endpoint}&ch=serial&tail=${Math.min(tail, 500)}&text`;
        const serialRes = await fetch(serialUrl, {
          headers: phalaHeaders(),
        });

        if (serialRes.ok) {
          const rawLogs = await serialRes.text();
          const filtered = filterSecrets(rawLogs);
          return NextResponse.json({
            logs: filtered,
            line_count: filtered.split("\n").filter(Boolean).length,
            source: "serial",
          });
        }
      }
    }

    return NextResponse.json({ logs: "No logs available yet. The CVM may still be starting up.", line_count: 0, source: "none" });
  } catch (err) {
    console.error("[logs] Error fetching logs:", err);
    return NextResponse.json({ error: "Failed to fetch logs", details: String(err) }, { status: 500 });
  }
}

/** Filter lines that might leak secrets */
function filterSecrets(logs: string): string {
  return logs
    .split("\n")
    .filter(line => {
      const lower = line.toLowerCase();
      // Only filter lines with actual key=value patterns, not just the word "token"
      return !lower.includes("api_key=sk-") &&
             !lower.includes("bot_token=") &&
             !lower.includes("\"token\":") &&
             !/sk-ant-[a-z0-9]{10,}/i.test(line);
    })
    .join("\n");
}
