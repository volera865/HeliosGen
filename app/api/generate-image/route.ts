import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ error: "Removed" }, { status: 410 });
}

export async function GET() {
  return NextResponse.json({ error: "Removed" }, { status: 410 });
}
