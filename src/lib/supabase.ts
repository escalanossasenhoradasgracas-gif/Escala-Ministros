// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supa = createClient(url, anon, {
  auth: { persistSession: false }, // não usamos Auth do Supabase por enquanto
})
