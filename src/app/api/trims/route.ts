import { NextResponse } from "next/server";
import { getDatasetTrims } from "@/lib/carDataset";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const make = searchParams.get("make");
  const model = searchParams.get("model");
  const year = searchParams.get("year");

  if (!make || !model || !year) {
    return NextResponse.json(
      { error: "Make, model, and year are required." },
      { status: 400 }
    );
  }

  return NextResponse.json({
    trims: getDatasetTrims(make, model, Number(year)),
  });
}