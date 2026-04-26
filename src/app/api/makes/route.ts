import { NextResponse } from "next/server";
import { getDatasetMakes } from "@/lib/carDataset";

export async function GET() {
  return NextResponse.json({
    makes: getDatasetMakes(),
  });
}