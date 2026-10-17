import { supabase, API_BASE } from "./supabase";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  workshop_name: string;
  owner_name: string;
  email?: string | null;
  plan?: string | null;
  subscription_status?: string | null;
  subscription_ends_at?: string | null;
  onboarding_completed?: boolean | null;
  created_at: string;
  is_admin: boolean;

  phone?: string | null;
  whatsapp?: string | null;
  instagram?: string | null;

  street?: string | null;
  number?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;

  logo_url?: string | null;
}
export interface Client {
  id: string;
  workshop_id: string;
  name: string;
  phone: string;
  whatsapp: string;
  created_at: string;
}

export interface Vehicle {
  id: string;
  workshop_id: string;
  client_id: string;
  plate: string;
  brand: string;
  model: string;
  year: string;
  mileage: string;
  created_at: string;
}

export type OrderStatus = "aguardando" | "em_manutencao" | "finalizado";

export interface ServiceOrder {
  id: string;
  workshop_id: string;
  client_id: string;
  vehicle_id: string;
  reported_issue: string;
  employee_name?: string;
  services_performed: string;
  value: string;
  status: OrderStatus;
  notes: string;
  delivery_date?: string | null;
  checklist?: string | null;
  created_at: string;
  updated_at: string;
  public_token?: string;
}

export interface FinancialEntry {
  id: string;
  workshop_id: string;
  description: string;
  amount: number;
  type: "income" | "expense";
  category: string;
  created_at: string;
}

// ─── Financial ───────────────────────────────────────────────────────────────

export async function getFinancialEntries(): Promise<FinancialEntry[]> {
  return apiFetch<FinancialEntry[]>("/financial");
}

export async function createFinancialEntry(data: {
  description: string;
  amount: number;
  type: "income" | "expense";
  category?: string;
}): Promise<FinancialEntry> {
  return apiFetch<FinancialEntry>("/financial", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteFinancialEntry(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/financial/${id}`, {
    method: "DELETE",
  });
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!API_BASE) {
    throw new Error("API_BASE não configurada. Verifique VITE_API_BASE.");
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  let json: any = null;

  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(json?.error ?? "Erro na requisição");
  }

  return json as T;
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export async function getProfile(): Promise<Profile | null> {
  return apiFetch<Profile | null>("/profile");
}

export async function upsertProfile(data: Partial<Profile>): Promise<Profile> {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return apiFetch<Profile>("/profile", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      email: user?.email ?? null,
    }),
  });
}

// ─── Clients ─────────────────────────────────────────────────────────────────

export async function getClients(): Promise<Client[]> {
  return apiFetch<Client[]>("/clients");
}

export async function createClient_(data: {
  name: string;
  phone: string;
  whatsapp: string;
}): Promise<Client> {
  return apiFetch<Client>("/clients", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateClient(
  id: string,
  data: { name: string; phone: string; whatsapp: string },
): Promise<Client> {
  return apiFetch<Client>(`/clients/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteClient(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/clients/${id}`, { method: "DELETE" });
}

// ─── Vehicles ─────────────────────────────────────────────────────────────────

export async function getVehicles(): Promise<Vehicle[]> {
  return apiFetch<Vehicle[]>("/vehicles");
}

export async function createVehicle(
  data: Omit<Vehicle, "id" | "workshop_id" | "created_at">,
): Promise<Vehicle> {
  return apiFetch<Vehicle>("/vehicles", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateVehicle(
  id: string,
  data: Omit<Vehicle, "id" | "workshop_id" | "created_at">,
): Promise<Vehicle> {
  return apiFetch<Vehicle>(`/vehicles/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteVehicle(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/vehicles/${id}`, { method: "DELETE" });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function getOrders(): Promise<ServiceOrder[]> {
  return apiFetch<ServiceOrder[]>("/orders");
}

export async function createOrder(
  data: Omit<ServiceOrder, "id" | "workshop_id" | "created_at" | "updated_at">,
): Promise<ServiceOrder> {
  return apiFetch<ServiceOrder>("/orders", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateOrder(
  id: string,
  data: Partial<ServiceOrder>,
): Promise<ServiceOrder> {
  return apiFetch<ServiceOrder>(`/orders/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function deleteOrder(id: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/orders/${id}`, { method: "DELETE" });
}

export interface BillingCheckoutResponse {
  id: string;
  checkout_url: string;
  provider: "asaas";
}

export async function createCheckout(): Promise<BillingCheckoutResponse> {
  return apiFetch<BillingCheckoutResponse>("/billing/create-checkout", {
    method: "POST",
  });
}

export async function createSubscriptionCheckout(): Promise<BillingCheckoutResponse> {
  return apiFetch<BillingCheckoutResponse>("/billing/create-subscription", {
    method: "POST",
  });
}

export async function cancelSubscription(): Promise<{
  ok: boolean;
  message: string;
  expires_at?: string | null;
}> {
  return apiFetch("/billing/cancel-subscription", {
    method: "POST",
  });
}
