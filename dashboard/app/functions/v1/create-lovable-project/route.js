import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ success: false, error: "create-lovable-project is not implemented." }, { status: 501 });
}
