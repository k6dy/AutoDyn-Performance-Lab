import { NextResponse } from "next/server";
import { compareToBenchmark, simulateVehicle } from "@/lib/simulator";
import { lookupVehicle } from "@/lib/vehicleLookup";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query");

  if (!query || query.trim().length < 2) {
    return NextResponse.json(
      { error: "Query must be at least 2 characters." },
      { status: 400 }
    );
  }

  const vehicle = await lookupVehicle(query);
  const simulation = simulateVehicle(vehicle);
  const comparison = compareToBenchmark(vehicle, simulation);

  return NextResponse.json({
    vehicle,
    simulation,
    comparison,
  });
}