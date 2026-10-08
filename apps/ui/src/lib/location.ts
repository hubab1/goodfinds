import { z } from "zod";
import { locationSchema } from "@goodfinds/contracts/integrations";
import type { Location } from "@goodfinds/contracts/integrations";

export const LOCATION_DOMAINS = [
  "https://ipwho.is",
  "https://api.bigdatacloud.net",
  "https://api.postcodes.io",
  "https://api.zippopotam.us",
];
async function json(
  url: string,
  fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): Promise<unknown> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(12_000),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "Location service is busy. Enter your area manually or try later."
        : "Location lookup unavailable. You can enter your area manually.",
    );
  const data: unknown = await response.json();
  return data;
}
export async function estimateIP(
  fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
): Promise<Location> {
  const raw = await json(
    "https://ipwho.is/?fields=success,message,latitude,longitude,city,region,country_code",
    fetcher,
  );
  const data = z
    .object({
      success: z.boolean(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      city: z.string().optional(),
      region: z.string().optional(),
      country_code: z.string().optional(),
    })
    .parse(raw);
  if (
    !data.success ||
    data.latitude === undefined ||
    data.longitude === undefined ||
    !data.country_code
  )
    throw new Error("Could not estimate your area. Enter it manually.");
  return locationSchema.parse({
    source: "ip",
    latitude: data.latitude,
    longitude: data.longitude,
    accuracy_m: null,
    area: [data.city, data.region].filter(Boolean).join(", ") || data.country_code,
    country: data.country_code,
    acquired_at: new Date().toISOString(),
    display: "town",
  });
}
export async function deviceLocation(
  geolocation: Pick<Geolocation, "getCurrentPosition"> | undefined = navigator.geolocation,
  fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
): Promise<Location> {
  if (!geolocation)
    throw new Error("Location is unavailable here. Open it in a browser or enter your area.");
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    geolocation.getCurrentPosition(
      resolve,
      (error) =>
        reject(
          new Error(
            error.code === 1
              ? "Location access was declined. Estimate your location or enter your area."
              : "Couldn't find your location. Estimate it or enter your area.",
          ),
        ),
      { maximumAge: 0, timeout: 12_000, enableHighAccuracy: false },
    );
  });
  const { latitude, longitude, accuracy } = position.coords;
  z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().nonnegative(),
  }).parse({ latitude, longitude, accuracy });
  // The free endpoint requires fresh device coordinates and a direct same-client call.
  const raw = await json(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`,
    fetcher,
  );
  const data = z
    .object({
      city: z.string().optional(),
      locality: z.string().optional(),
      principalSubdivision: z.string().optional(),
      countryCode: z.string(),
    })
    .parse(raw);
  return locationSchema.parse({
    source: "device",
    latitude,
    longitude,
    accuracy_m: accuracy,
    area:
      [data.city || data.locality, data.principalSubdivision].filter(Boolean).join(", ") ||
      data.countryCode,
    country: data.countryCode,
    acquired_at: new Date(position.timestamp).toISOString(),
    display: "town",
  });
}
export async function lookupPostal(
  country: string,
  value: string,
  fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
): Promise<Location[]> {
  const code = value.trim().toUpperCase();
  if (!code) throw new Error("Enter a postal code");
  if (country === "GB") {
    if (code.startsWith("BT"))
      throw new Error("Postcode lookup is unavailable for this area. Enter your town instead.");
    const outcode = /^[A-Z]{1,2}\d[A-Z\d]?$/u.test(code);
    const raw = await json(
      `https://api.postcodes.io/${outcode ? "outcodes" : "postcodes"}/${encodeURIComponent(code)}`,
      fetcher,
    );
    const data = z
      .object({
        result: z.object({
          latitude: z.number(),
          longitude: z.number(),
          admin_district: z.union([z.string(), z.array(z.string())]).nullable(),
        }),
      })
      .parse(raw).result;
    const area = Array.isArray(data.admin_district)
      ? data.admin_district.join(", ")
      : data.admin_district || code;
    return [
      locationSchema.parse({
        source: "postal",
        latitude: data.latitude,
        longitude: data.longitude,
        accuracy_m: null,
        area,
        country,
        postal_code: code,
        acquired_at: new Date().toISOString(),
        display: "postal",
      }),
    ];
  }
  const raw = await json(
    `https://api.zippopotam.us/${encodeURIComponent(country.toLowerCase())}/${encodeURIComponent(code)}`,
    fetcher,
  );
  const data = z
    .object({
      places: z.array(
        z.object({
          "place name": z.string(),
          latitude: z.string(),
          longitude: z.string(),
          state: z.string().optional(),
        }),
      ),
    })
    .parse(raw);
  return data.places.slice(0, 20).map((place) =>
    locationSchema.parse({
      source: "postal",
      latitude: Number(place.latitude),
      longitude: Number(place.longitude),
      accuracy_m: null,
      area: [place["place name"], place.state].filter(Boolean).join(", "),
      country,
      postal_code: code,
      acquired_at: new Date().toISOString(),
      display: "postal",
    }),
  );
}
