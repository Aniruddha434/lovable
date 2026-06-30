import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ success: false, error: "remove-watermark is not implemented." }, { status: 501 });
}
