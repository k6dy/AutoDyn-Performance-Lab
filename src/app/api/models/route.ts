import { NextResponse } from "next/server";
import {
  getDatasetModels,
  getDatasetYearsForMake,
} from "@/lib/carDataset";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const make = searchParams.get("make");
  const year = searchParams.get("year");

  if (!make) {
    return NextResponse.json(
      { error: "Make is required." },
      { status: 400 }
    );
  }

  if (!year) {
    return NextResponse.json({
      years: getDatasetYearsForMake(make),
      models: [],
    });
  }

  return NextResponse.json({
    models: getDatasetModels(make, Number(year)),
  });
}