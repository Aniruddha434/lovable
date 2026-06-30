import { NextResponse } from "next/server";

export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  return NextResponse.json({ success: true, optimized_prompt: String(body.prompt || "").trim() });
}
