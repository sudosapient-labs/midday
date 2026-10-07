import * as crypto from "node:crypto";
import { LogEvents } from "@midday/events/events";
import { setupAnalytics } from "@midday/events/server";
import { triggerJob } from "@midday/job-client";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Delay the welcome email so it arrives after the user finishes signing up
const ONBOARDING_DELAY_MS = 10 * 60 * 1000;

// NOTE: This is trigger from supabase database webhook
export async function POST(req: Request) {
  const text = await req.clone().text();
  const signature = (await headers()).get("x-supabase-signature");

  if (!signature) {
    return NextResponse.json({ message: "Missing signature" }, { status: 401 });
  }

  const decodedSignature = Buffer.from(signature, "base64");

  const calculatedSignature = crypto
    .createHmac("sha256", process.env.WEBHOOK_SECRET_KEY!)
    .update(text)
    .digest();

  const hmacMatch =
    decodedSignature.length === calculatedSignature.length &&
    crypto.timingSafeEqual(decodedSignature, calculatedSignature);

  if (!hmacMatch) {
    return NextResponse.json({ message: "Not Authorized" }, { status: 401 });
  }

  const body = await req.json();

  const userId = body.record.id;

  const analytics = await setupAnalytics();

  analytics.track({
    event: LogEvents.Registered.name,
    channel: LogEvents.Registered.channel,
  });

  await triggerJob("onboard-team", { userId }, "teams", {
    delay: ONBOARDING_DELAY_MS,
    // Supabase may retry the webhook; only onboard each user once
    jobId: `onboard-team-${userId}`,
  });

  return NextResponse.json({ success: true });
}
