import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({
    success: false,
    error: "proxy-command is not implemented. Add your own authorized Lovable integration here.",
  }, { status: 501 });
}
