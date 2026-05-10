import { NextResponse } from "next/server";
import { simulateVehicle } from "@/lib/simulator";
import { lookupVehicle } from "@/lib/vehicleLookup";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const year = Number(searchParams.get("year"));
    const make = searchParams.get("make");
    const model = searchParams.get("model");

    if (!year || !make || !model) {
      return NextResponse.json(
        {
          error: "Missing required vehicle information.",
        },
        { status: 400 }
      );
    }

    const vehicle = await lookupVehicle(`${year} ${make} ${model}`);

    if (!vehicle) {
      return NextResponse.json(
        {
          error: "Vehicle not found.",
        },
        { status: 404 }
      );
    }

    const simulation = simulateVehicle(vehicle);

    return NextResponse.json({
      success: true,
      vehicle,
      simulation,
    });
  } catch (error) {
    console.error("Vehicle search API error:", error);

    return NextResponse.json(
      {
        error: "Internal server error.",
      },
      { status: 500 }
    );
  }
}