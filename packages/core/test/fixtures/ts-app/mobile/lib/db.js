import { createClient } from "@supabase/supabase-js";

export const supabase = createClient("https://x.supabase.co", "anon");

export async function listPlaces(city) {
  const { data } = await supabase.from("places").select("*").eq("city", city);
  return data;
}

export async function reportPlace(id, reason) {
  await supabase.from("reports").insert({ place_id: id, reason });
}

export async function nearby(lat, lng) {
  return supabase.rpc("nearby_places", { lat, lng });
}

export async function uploadPhoto(path, file) {
  await supabase.storage.from("photos").upload(path, file);
}

export async function restCount(base) {
  return fetch(`${base}/rest/v1/places?select=id`);
}
