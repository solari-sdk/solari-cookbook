/**
 * Resolve a display label from the viewer's IANA time zone.
 *
 * Both halves must come from the *same* source. Taking the city from the time
 * zone and the country from `navigator.language` produced nonsense like
 * "Calcutta · US" for anyone whose browser language is US English but who is
 * physically elsewhere — the locale describes the language, not the location.
 */

/**
 * IANA zone -> ISO 3166-1 alpha-2. Only the zones a browser is realistically
 * set to; anything unlisted falls back to the bare city name.
 */
const ZONE_COUNTRY: Record<string, string> = {
  // Asia
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Asia/Karachi": "PK",
  "Asia/Dhaka": "BD",
  "Asia/Colombo": "LK",
  "Asia/Kathmandu": "NP",
  "Asia/Dubai": "AE",
  "Asia/Riyadh": "SA",
  "Asia/Qatar": "QA",
  "Asia/Kuwait": "KW",
  "Asia/Tehran": "IR",
  "Asia/Baghdad": "IQ",
  "Asia/Jerusalem": "IL",
  "Asia/Tel_Aviv": "IL",
  "Asia/Istanbul": "TR",
  "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR",
  "Asia/Shanghai": "CN",
  "Asia/Chongqing": "CN",
  "Asia/Hong_Kong": "HK",
  "Asia/Taipei": "TW",
  "Asia/Singapore": "SG",
  "Asia/Kuala_Lumpur": "MY",
  "Asia/Jakarta": "ID",
  "Asia/Manila": "PH",
  "Asia/Bangkok": "TH",
  "Asia/Ho_Chi_Minh": "VN",
  "Asia/Saigon": "VN",
  "Asia/Yangon": "MM",
  "Asia/Almaty": "KZ",
  "Asia/Tashkent": "UZ",
  "Asia/Baku": "AZ",
  "Asia/Tbilisi": "GE",
  "Asia/Yerevan": "AM",
  "Asia/Amman": "JO",
  "Asia/Beirut": "LB",
  "Asia/Damascus": "SY",
  "Asia/Muscat": "OM",
  "Asia/Bahrain": "BH",
  "Asia/Kabul": "AF",

  // Europe
  "Europe/London": "GB",
  "Europe/Dublin": "IE",
  "Europe/Lisbon": "PT",
  "Europe/Madrid": "ES",
  "Europe/Paris": "FR",
  "Europe/Brussels": "BE",
  "Europe/Amsterdam": "NL",
  "Europe/Luxembourg": "LU",
  "Europe/Berlin": "DE",
  "Europe/Zurich": "CH",
  "Europe/Vienna": "AT",
  "Europe/Rome": "IT",
  "Europe/Malta": "MT",
  "Europe/Copenhagen": "DK",
  "Europe/Oslo": "NO",
  "Europe/Stockholm": "SE",
  "Europe/Helsinki": "FI",
  "Europe/Tallinn": "EE",
  "Europe/Riga": "LV",
  "Europe/Vilnius": "LT",
  "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ",
  "Europe/Bratislava": "SK",
  "Europe/Budapest": "HU",
  "Europe/Ljubljana": "SI",
  "Europe/Zagreb": "HR",
  "Europe/Belgrade": "RS",
  "Europe/Sarajevo": "BA",
  "Europe/Skopje": "MK",
  "Europe/Tirane": "AL",
  "Europe/Sofia": "BG",
  "Europe/Bucharest": "RO",
  "Europe/Chisinau": "MD",
  "Europe/Athens": "GR",
  "Europe/Nicosia": "CY",
  "Europe/Kyiv": "UA",
  "Europe/Kiev": "UA",
  "Europe/Minsk": "BY",
  "Europe/Moscow": "RU",
  "Europe/Kaliningrad": "RU",
  "Europe/Samara": "RU",
  "Europe/Reykjavik": "IS",
  "Atlantic/Reykjavik": "IS",

  // Americas
  "America/New_York": "US",
  "America/Detroit": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Phoenix": "US",
  "America/Los_Angeles": "US",
  "America/Anchorage": "US",
  "Pacific/Honolulu": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Edmonton": "CA",
  "America/Winnipeg": "CA",
  "America/Halifax": "CA",
  "America/St_Johns": "CA",
  "America/Mexico_City": "MX",
  "America/Monterrey": "MX",
  "America/Tijuana": "MX",
  "America/Guatemala": "GT",
  "America/Panama": "PA",
  "America/Bogota": "CO",
  "America/Lima": "PE",
  "America/Caracas": "VE",
  "America/Santiago": "CL",
  "America/Argentina/Buenos_Aires": "AR",
  "America/Sao_Paulo": "BR",
  "America/Bahia": "BR",
  "America/Manaus": "BR",
  "America/Montevideo": "UY",
  "America/Asuncion": "PY",
  "America/La_Paz": "BO",
  "America/Havana": "CU",
  "America/Jamaica": "JM",
  "America/Puerto_Rico": "PR",
  "America/Santo_Domingo": "DO",
  "America/Costa_Rica": "CR",

  // Africa
  "Africa/Cairo": "EG",
  "Africa/Lagos": "NG",
  "Africa/Accra": "GH",
  "Africa/Abidjan": "CI",
  "Africa/Dakar": "SN",
  "Africa/Casablanca": "MA",
  "Africa/Algiers": "DZ",
  "Africa/Tunis": "TN",
  "Africa/Tripoli": "LY",
  "Africa/Khartoum": "SD",
  "Africa/Addis_Ababa": "ET",
  "Africa/Nairobi": "KE",
  "Africa/Kampala": "UG",
  "Africa/Dar_es_Salaam": "TZ",
  "Africa/Kigali": "RW",
  "Africa/Luanda": "AO",
  "Africa/Kinshasa": "CD",
  "Africa/Harare": "ZW",
  "Africa/Lusaka": "ZM",
  "Africa/Maputo": "MZ",
  "Africa/Johannesburg": "ZA",

  // Oceania
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Brisbane": "AU",
  "Australia/Adelaide": "AU",
  "Australia/Perth": "AU",
  "Australia/Hobart": "AU",
  "Australia/Darwin": "AU",
  "Pacific/Auckland": "NZ",
  "Pacific/Fiji": "FJ",
  "Pacific/Guam": "GU",
  "Pacific/Port_Moresby": "PG",
};

/** Legacy tzdb aliases the browser may still report. */
const CITY_ALIASES: Record<string, string> = {
  Calcutta: "Kolkata",
  Saigon: "Ho Chi Minh City",
  Kiev: "Kyiv",
  Bombay: "Mumbai",
  Madras: "Chennai",
  Rangoon: "Yangon",
};

export interface TimezoneLabel {
  /** e.g. "Kolkata" */
  city: string;
  /** ISO 3166-1 alpha-2, e.g. "IN". `null` when the zone is unmapped. */
  country: string | null;
  /** e.g. "Kolkata · IN" */
  label: string;
}

export function readTimezoneLabel(): TimezoneLabel {
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    zone = "";
  }

  const rawCity = zone.split("/").pop()?.replace(/_/g, " ") ?? "";
  const city = CITY_ALIASES[rawCity] ?? (rawCity || "Local");
  const country = ZONE_COUNTRY[zone] ?? null;

  return { city, country, label: country ? `${city} · ${country}` : city };
}
