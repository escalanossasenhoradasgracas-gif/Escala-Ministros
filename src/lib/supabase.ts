// src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anon) {
  // Ajuda a diagnosticar se as variáveis não chegaram
  console.warn("Supabase ENV faltando: verifique VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY");
}

export const supabase = createClient(url, anon, {
  auth: {
    persistSession: false, // por enquanto (estamos usando “login simples” no app)
  },
});
