import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ success: false, error: "enable-cloud is not implemented." }, { status: 501 });
}
