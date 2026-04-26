import { NextResponse } from "next/server";
import { getDatasetVehicleSpecs } from "@/lib/carDataset";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const trimId = searchParams.get("trimId");

  if (!trimId) {
    return NextResponse.json(
      { error: "Trim ID is required." },
      { status: 400 }
    );
  }

  const specs = getDatasetVehicleSpecs(trimId);

  if (!specs) {
    return NextResponse.json(
      { error: "Specs not found for selected trim." },
      { status: 404 }
    );
  }

  return NextResponse.json({
    found: true,
    specs,
  });
}