// Shared (client + server) catalog constants.

/** Model years covered by the bundled specification dataset. */
export const DATASET_YEARS = [2020, 2019, 2018, 2017, 2016, 2015];

export function selectableYears(now = new Date()) {
  const last = now.getFullYear() + 1;
  return Array.from({ length: last - 1981 + 1 }, (_, i) => last - i);
}

export const hasDatasetSpecs = (year: number) => DATASET_YEARS.includes(year);

/**
 * Passenger-vehicle makes offered for years outside the dataset. Models for these come from NHTSA
 * vPIC at request time, so an invalid make/year combination simply returns no models.
 */
export const IDENTIFICATION_MAKES = [
  "Acura", "Alfa Romeo", "Aston Martin", "Audi", "Bentley", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler",
  "Daewoo", "Dodge", "Eagle", "Ferrari", "FIAT", "Fisker", "Ford", "Genesis", "Geo", "GMC", "Honda", "Hummer",
  "Hyundai", "INFINITI", "Isuzu", "Jaguar", "Jeep", "Kia", "Lamborghini", "Land Rover", "Lexus", "Lincoln", "Lotus",
  "Lucid", "Maserati", "Mazda", "McLaren", "Mercedes-Benz", "Mercury", "MINI", "Mitsubishi", "Nissan", "Oldsmobile",
  "Plymouth", "Polestar", "Pontiac", "Porsche", "Ram", "Rivian", "Rolls-Royce", "Saab", "Saturn", "Scion", "smart",
  "Subaru", "Suzuki", "Tesla", "Toyota", "VinFast", "Volkswagen", "Volvo",
];
