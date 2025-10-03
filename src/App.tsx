// @ts-nocheck

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from './lib/supabase';
/***********************
 * ESCALA DE MINISTROS — APP (Mobile 390px)
 * Mudanças atuais:
 *  - Disponibilidade: seleção por clique + recorrência semanal (apenas fixos).
 *  - Extras: aparecem no calendário; ao remover na aba Missas Extras
 *    as seleções de disponibilidade (de todos) para aquele horário são limpas.
 *  - Exportar (PDF): fontes e espaçamentos reduzidos p/ caber 1 página por horário.
 ***********************/

// =====================
// STORAGE KEYS
// =====================
const LS_HORARIOS = "escala.horarios";
const LS_EXTRAS = "escala.extras";
const LS_ESCALA_CALENDAR = "escala.calendar";
const LS_MINISTERS = "escala.ministers";
const LS_AVAILABILITY = "escala.availability";
const LS_AUTH = "escala.auth";
const LS_SCHEMA_VERSION = "escala.schemaVersion";
const CURRENT_SCHEMA = 2; // ↑ aumente quando mudar horários fixos
const LS_DIRTY_AVAIL = "escala.disponibilidade.dirty";
const LS_DIRTY_EXTRAS = "escala.extras.dirty";
const LS_REMEMBER = "escala.auth.remember";

// Política: só há sessão persistida se LS_REMEMBER === "true".
// Se existir LS_AUTH sem a flag, apagamos (força novo login).
(function enforceRememberPolicy() {
  try {
    const remember = localStorage.getItem(LS_REMEMBER) === "true";
    if (!remember) {
      localStorage.removeItem(LS_AUTH);
    }
  } catch {}
})();

// === CONTROLE DE JANELA DE EDIÇÃO — DISPONIBILIDADE ===
const LS_AVAIL_SETTINGS = "escala.availability.settings";

type AvailSettings = {
  mode: "auto" | "manual";
  manualOpen: boolean; // só vale quando mode === "manual"
  autoDaysBeforeEnd: number; // ex.: 10  (abre N dias antes do fim do mês até 01 do mês seguinte)
  customByMonth: {
    // "YYYY-MM": { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
    [ym: string]: { from?: string; to?: string } | undefined;
  };
};

function loadAvailSettings(): AvailSettings {
  return loadJSON(LS_AVAIL_SETTINGS, {
    mode: "auto",
    manualOpen: false,
    autoDaysBeforeEnd: 10,
    customByMonth: {},
  });
}
function saveAvailSettings(s: AvailSettings) {
  saveJSON(LS_AVAIL_SETTINGS, s);
}

function ymOf(year: number, monthZero: number) {
  return `${year}-${String(monthZero + 1).padStart(2, "0")}`;
}
function firstDayOfNextMonthISO(year: number, monthZero: number) {
  return new Date(year, monthZero + 1, 1).toISOString().slice(0, 10);
}
function lastDayOfMonthISO(year: number, monthZero: number) {
  return new Date(year, monthZero + 1, 0).toISOString().slice(0, 10);
}
function ymFromISODate(iso: string) {
  // recebe "YYYY-MM-DD" e devolve "YYYY-MM"
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return ymOf(d.getFullYear(), d.getMonth());
}
function parseYm(ym: string) {
  // recebe "YYYY-MM" e devolve { year, monthZero }
  const [y, m] = (ym || "0-1").split("-");
  return { year: parseInt(y, 10) || 0, monthZero: (parseInt(m, 10) || 1) - 1 };
}

/**
 * Retorna se a janela de edição está ABERTA para o mês (para usuários não-admin).
 * Regras:
 * - Se existir data personalizada para o mês: usa {from,to}.
 * - Senão, se modo manual: usa manualOpen.
 * - Senão (automático): abre de (último dia - (N-1)) até 01 do mês seguinte (inclusive).
 *   Ex.: N=10 → abre do dia 22 até 01 do mês seguinte (num mês de 31 dias).
 */
function isAvailabilityOpenForMonth(
  settings: AvailSettings,
  year: number,
  monthZero: number,
  todayIso = todayISO()
) {
  const ym = ymOf(year, monthZero);
  const custom = settings.customByMonth?.[ym];
  if (custom?.from || custom?.to) {
    const from = custom.from || "0000-01-01";
    const to = custom.to || "9999-12-31";
    return todayIso >= from && todayIso <= to;
  }

  if (settings.mode === "manual") return !!settings.manualOpen;

  // automático
  const lastIso = lastDayOfMonthISO(year, monthZero);
  const last = new Date(lastIso + "T00:00:00");
  const n = Math.max(1, Math.floor(settings.autoDaysBeforeEnd || 10));
  const start = new Date(last);
  start.setDate(last.getDate() - (n - 1)); // inclui o último dia
  const startIso = start.toISOString().slice(0, 10);
  const endIso = firstDayOfNextMonthISO(year, monthZero);
  return todayIso >= startIso && todayIso <= endIso;
}

// =====================
// CONSTS & HELPERS
// =====================
function nextMonthOf(dateIso: string) {
  const d = new Date(dateIso + "T00:00:00");
  const y = d.getFullYear();
  const m0 = d.getMonth();
  const next = new Date(y, m0 + 1, 1);
  return { year: next.getFullYear(), monthZero: next.getMonth() };
}
function ymFromYearMonth(year: number, monthZero: number) {
  return `${year}-${String(monthZero + 1).padStart(2, "0")}`;
}
// ===== Pequeno seletor de horário (HH:MM) =====
function LegacyTimeInput({
  value,
  onChange,
  placeholder = "HH:MM",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  function normalize(v: string) {
    return timeToCanonical(v || "");
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="\d{1,2}[:h.]?\d{2}"
      value={value}
      onChange={(e) => onChange(normalize((e.target as any).value))}
      onBlur={(e) => onChange(normalize((e.target as any).value))}
      placeholder={placeholder}
      className="border rounded-xl px-2 py-1 w-24 text-center"
      title="Digite o horário (ex.: 06:30)"
    />
  );
}

const LOGO_URL =
  "https://lh3.googleusercontent.com/pw/AP1GczPRoT72PO_QR2XBR3csY_3dxIgCf90xCGxpstckkZhvRhQGvHej6tfAvhwLtqomkV8uh8nRcvetyW80gQbl6JSu_lR0cXGNO0GPLgMmFy8RDMAmw1e_F1Q00JEv4GmIbsrhWCZA3gO-IttNSXC0ncV9=w800-h800-s-no-gm?authuser=0";
const DOW_LABELS = [
  "Domingo",
  "Segunda-Feira",
  "Terça-Feira",
  "Quarta-Feira",
  "Quinta-Feira",
  "Sexta-Feira",
  "Sábado",
];
const DOW_SHORT = ["D", "S", "T", "Q", "Q", "S", "S"];

const loadJSON = (k: string, fb: any) => {
  try {
    const r = localStorage.getItem(k);
    return r ? JSON.parse(r) : fb;
  } catch {
    return fb;
  }
};

const saveJSON = (k: string, v: any) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};

const todayISO = () =>
  new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    new Date().getDate()
  )
    .toISOString()
    .slice(0, 10);
const dateBr = (iso: string) => {
  const [y, m, d] = (iso || "").split("-");
  if (!y) return "";
  return `${d}/${m}/${y}`;
};
function timeToCanonical(t: string) {
  const s = (t || "").toString().trim().toLowerCase().replace(/h/g, ":");
  const m = s.match(/^(\d{1,2})[:.](\d{2})$/) || s.match(/^(\d{2})(\d{2})$/);
  let hh = 0,
    mm = 0;
  if (m) {
    hh = parseInt(m[1] || "0", 10);
    mm = parseInt(m[2] || "0", 10);
  }
  hh = Math.min(23, Math.max(0, hh));
  mm = Math.min(59, Math.max(0, mm));
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function daysInMonth(year: number, monthZero: number) {
  const arr: string[] = [];
  const last = new Date(year, monthZero + 1, 0).getDate();
  for (let i = 1; i <= last; i++)
    arr.push(new Date(year, monthZero, i).toISOString().slice(0, 10));
  return arr;
}
const horarioId = (dow: number, time: string) =>
  `${dow}-${timeToCanonical(time)}`;
const monthName = (i: number) =>
  [
    "JANEIRO",
    "FEVEREIRO",
    "MARÇO",
    "ABRIL",
    "MAIO",
    "JUNHO",
    "JULHO",
    "AGOSTO",
    "SETEMBRO",
    "OUTUBRO",
    "NOVEMBRO",
    "DEZEMBRO",
  ][i] || "";

// Chave única do evento (diferencia FIXO x EXTRA)
function eventKey(ev: {
  kind: "fixed" | "extra";
  time: string;
  name?: string;
}) {
  return ev.kind === "extra" ? `X|${ev.time}|${ev.name || ""}` : `F|${ev.time}`;
}
// Compat: chaves antigas eram só "HH:MM"
function isLegacyTimeKey(k: string) {
  return /^\d{2}:\d{2}$/.test(k);
}

// Extra banida: 00:00 - SAGRADO CORAÇÃO DE JESUS
function isBannedExtra(time: string, name?: string) {
  return (
    time === "00:00" &&
    String(name || "")
      .trim()
      .toUpperCase()
      .includes("SAGRADO CORAÇÃO DE JESUS")
  );
}

// =====================
// SEEDS & MIGRAÇÕES
// =====================
function defaultHorariosSeed() {
  const base: any[] = [];
  const add = (d: number, t: string) => {
    const hhmm = timeToCanonical(t);
    base.push({
      id: horarioId(d, hhmm),
      dow: d,
      time: hhmm,
      min: 4,
      max: 12,
      ativo: true,
    });
  };
  // Seg-Sex: 06:30, 11:30, 19:00 (sem 18:30 / 23:30)
  [1, 2, 3, 4, 5].forEach((d) =>
    ["06:30", "11:30", "19:00"].forEach((t) => add(d, t))
  );
  // Sábado: 06:30, 19:00
  add(6, "06:30");
  add(6, "19:00");
  // Domingo: 06:30, 08:30, 11:00, 19:00
  ["06:30", "08:30", "11:00", "19:00"].forEach((t) => add(0, t));
  return base;
}

// Remoção global de horários 18:30 e 23:30 (apagar em todo o sistema)
function purgeOldTimes() {
  const banned = new Set(["18:30", "23:30"]);

  // Horários fixos
  const hs = loadJSON(LS_HORARIOS, []);
  const hsNext = (hs || []).filter((h: any) => !banned.has(h.time));
  if (hsNext.length !== (hs || []).length) saveJSON(LS_HORARIOS, hsNext);

  // Extras
  const ex = loadJSON(LS_EXTRAS, {});
  let exTouched = false;
  Object.keys(ex || {}).forEach((ym) => {
    const prev = (ex as any)[ym] || [];
    const list = prev.filter((e: any) => !banned.has(e.time));
    if (list.length !== prev.length) {
      (ex as any)[ym] = list;
      exTouched = true;
    }
  });
  if (exTouched) saveJSON(LS_EXTRAS, ex);

  // Disponibilidade
  const av = loadJSON(LS_AVAILABILITY, {});
  let avTouched = false;
  Object.keys(av || {}).forEach((user) => {
    Object.keys(av[user] || {}).forEach((ym) => {
      Object.keys(av[user][ym] || {}).forEach((date) => {
        const times = av[user][ym][date] || {};
        let changed = false;
        banned.forEach((t) => {
          // Remove chaves legadas "HH:MM" e também "F|HH:MM"
          if (t in times) {
            delete times[t as any];
            changed = true;
          }
          const fKey = `F|${t}`;
          if (fKey in times) {
            delete times[fKey as any];
            changed = true;
          }
        });
        if (changed) avTouched = true;
      });
    });
  });
  if (avTouched) saveJSON(LS_AVAILABILITY, av);

  // Calendário salvo
  const cal = loadJSON(LS_ESCALA_CALENDAR, {});
  let calTouched = false;
  Object.keys(cal || {}).forEach((ym) => {
    const dates = (cal as any)[ym] || {};
    Object.keys(dates).forEach((date) => {
      const before = dates[date] || [];
      const after = before.filter((ev: any) => !banned.has(ev.time));
      if (after.length !== before.length) {
        dates[date] = after;
        calTouched = true;
      }
    });
    (cal as any)[ym] = dates;
  });
  if (calTouched) saveJSON(LS_ESCALA_CALENDAR, cal);
}

function ensureSeeds() {
  if (!loadJSON(LS_HORARIOS, []).length)
    saveJSON(LS_HORARIOS, defaultHorariosSeed());
  if (!loadJSON(LS_MINISTERS, []).length)
    saveJSON(LS_MINISTERS, [
      {
        id: "admin",
        name: "Administrador",
        email: "admin@paroquia",
        fone: "",
        password: "admin123",
        loginKeys: ["admin", "admin@paroquia"],
        isAdmin: true,
        active: true,
      },
      {
        id: "usuario",
        name: "Usuário",
        email: "usuario@paroquia",
        fone: "",
        password: "123456",
        loginKeys: ["usuario", "usuario@paroquia"],
        isAdmin: false,
        active: true,
      },
    ]);
  saveJSON(LS_EXTRAS, loadJSON(LS_EXTRAS, {}));
  saveJSON(LS_ESCALA_CALENDAR, loadJSON(LS_ESCALA_CALENDAR, {}));
  saveJSON(LS_AVAILABILITY, loadJSON(LS_AVAILABILITY, {}));
}

function migrateLegacyAvailability() {
  const availability = loadJSON(LS_AVAILABILITY, {});
  let touched = false;

  Object.keys(availability || {}).forEach((userId) => {
    const months = availability[userId] || {};
    Object.keys(months).forEach((ym) => {
      const dates = months[ym] || {};
      Object.keys(dates).forEach((date) => {
        const byDate = dates[date] || {};
        let changed = false;

        Object.keys(byDate).forEach((k) => {
          // Se encontrar chave legada "HH:MM", converte para "F|HH:MM"
          const m = k.match(/^(\d{2}:\d{2})$/);
          if (m) {
            const hhmm = m[1];
            const newKey = `F|${hhmm}`;
            if (!byDate[newKey]) byDate[newKey] = !!byDate[k];
            delete byDate[k];
            changed = true;
          }
        });

        if (changed) {
          dates[date] = byDate;
          touched = true;
        }
      });
      months[ym] = dates;
    });
    availability[userId] = months;
  });

  if (touched) saveJSON(LS_AVAILABILITY, availability);
}

// inicialização
ensureSeeds();
applyMigrations();
purgeOldTimes();
migrateLegacyAvailability();
function applyMigrations() {
  const v = loadJSON(LS_SCHEMA_VERSION, 0);

  // Quando você mudar defaultHorariosSeed(), aumente CURRENT_SCHEMA
  if (v < CURRENT_SCHEMA) {
    // Se quiser **substituir** os horários para todos os dispositivos:
    saveJSON(LS_HORARIOS, defaultHorariosSeed());

    // Se quiser apenas apagar para recriar do zero:
    // localStorage.removeItem(LS_HORARIOS);

    saveJSON(LS_SCHEMA_VERSION, CURRENT_SCHEMA);
  }
}

// =====================
// CALENDÁRIO (recorrentes + extras)
// =====================
const loadCalendar = () => loadJSON(LS_ESCALA_CALENDAR, {});
const saveCalendar = (obj: any) => saveJSON(LS_ESCALA_CALENDAR, obj);
const loadExtras = () => loadJSON(LS_EXTRAS, {});

// Sincroniza o mês e limpa seleções inválidas (considerando chaves novas e legadas)
function buildMonthCalendar(year: number, monthZero: number) {
  const ym = `${year}-${String(monthZero + 1).padStart(2, "0")}`;

  // (1) Começa do zero — sem herdar nada previamente salvo
  const out: any = {};

  // (2) Horários fixos ativos
  const horarios = loadJSON(LS_HORARIOS, defaultHorariosSeed()).filter(
    (h: any) => h.ativo
  );
  const days = daysInMonth(year, monthZero);

  for (const date of days) {
    const dow = new Date(date + "T00:00:00").getDay();
    const list: any[] = [];
    (horarios as any[])
      .filter((h: any) => h.dow === dow)
      .forEach((h) => {
        list.push({ time: h.time, min: h.min, max: h.max, kind: "fixed" });
      });
    out[date] = list.sort((a, b) => a.time.localeCompare(b.time));
  }

  // (3) Missas Extras do mês (somente as existentes)
  const exList = (loadJSON(LS_EXTRAS, {})[ym] || []) as any[];
  for (const e of exList) {
    // ⬇⬇⬇ bloqueia extra proibida aqui
    if (isBannedExtra(e.time, e.name)) continue;

    if (!out[e.date]) out[e.date] = [];
    out[e.date] = out[e.date].filter(
      (ev: any) =>
        !(ev.kind === "extra" && ev.time === e.time && ev.name === e.name)
    );
    out[e.date].push({
      time: e.time,
      name: e.name,
      min: e.min,
      max: e.max,
      kind: "extra",
      color: "#7c3aed",
    });
    out[e.date].sort((a: any, b: any) => a.time.localeCompare(b.time));
  }

  // (4) Salva o mês consolidado (substitui o antigo por completo)
  const calAll = loadJSON(LS_ESCALA_CALENDAR, {});
  calAll[ym] = out;
  saveJSON(LS_ESCALA_CALENDAR, calAll);

  // (5) PURGE da disponibilidade para chaves inexistentes nesse novo mês
  const availability = loadJSON(LS_AVAILABILITY, {});
  let touched = false;

  Object.keys(availability || {}).forEach((userId) => {
    const monthObj = (availability as any)[userId]?.[ym] || {};
    Object.keys(monthObj).forEach((date) => {
      const allowed = new Set<string>();
      ((out[date] || []) as any[]).forEach((ev) => {
        if (ev.kind === "fixed") {
          allowed.add(`F|${ev.time}`);
        } else {
          allowed.add(`X|${ev.time}|${ev.name || ""}`);
        }
      });

      const timesObj = monthObj[date] || {};
      Object.keys(timesObj).forEach((k) => {
        if (!allowed.has(k)) {
          delete timesObj[k];
          touched = true;
        }
      });
      if (Object.keys(timesObj).length === 0) {
        delete monthObj[date];
        touched = true;
      }
    });

    if (!(availability as any)[userId]) (availability as any)[userId] = {};
    (availability as any)[userId][ym] = monthObj;
  });

  if (touched) saveJSON(LS_AVAILABILITY, availability);

  return out;
}

function buildMonthGridStrict(year: number, monthZero: number) {
  const first = new Date(year, monthZero, 1);
  const startDow = first.getDay();
  const daysCurr = new Date(year, monthZero + 1, 0).getDate();
  const grid: any[] = [];
  for (let i = 0; i < startDow; i++) grid.push({ empty: true });
  for (let d = 1; d <= daysCurr; d++) {
    const date = new Date(year, monthZero, d);
    grid.push({ d, iso: date.toISOString().slice(0, 10) });
  }
  while (grid.length % 7 !== 0) grid.push({ empty: true });
  return grid;
}

// =====================
// WIDGET: SmallTimePicker (carrossel HH/MM) — VERSÃO FINAL
// =====================
function SmallTimePicker({
  value,
  onChange,
  step = 5,
  disabled = false,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  step?: number; // intervalo de minutos (1, 5, 10, 15…)
  disabled?: boolean;
  className?: string;
}) {
  // normaliza valor recebido (ex.: "", "6:3", "06.30", "0630")
  const toCanonical = (t: string) => {
    const s = String(t || "")
      .trim()
      .toLowerCase()
      .replace(/h/g, ":");
    const m = s.match(/^(\d{1,2})[:.](\d{1,2})$/) ||
      s.match(/^(\d{2})(\d{2})$/) || ["", "00", "00"];
    let hh = parseInt(m[1] || "0", 10);
    let mm = parseInt(m[2] || "0", 10);
    hh = Math.min(23, Math.max(0, isFinite(hh) ? hh : 0));
    mm = Math.min(59, Math.max(0, isFinite(mm) ? mm : 0));
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };

  const canonical = toCanonical(value);
  const [hStr, mStr] = canonical.split(":");
  const h = Math.max(0, Math.min(23, parseInt(hStr, 10) || 0));
  const m = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));

  // opções de horas e minutos
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from(
    { length: Math.floor(60 / step) },
    (_, i) => i * step
  );

  const baseCls =
    "inline-flex items-center gap-1 border rounded-xl px-2 py-1 bg-white";
  const selCls =
    "appearance-none px-2 py-1 text-sm font-bold bg-transparent focus:outline-none";

  function setHour(newH: number) {
    const hh = String(Math.max(0, Math.min(23, newH))).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    onChange && onChange(`${hh}:${mm}`);
  }
  function setMinute(newM: number) {
    const hh = String(h).padStart(2, "0");
    const mm = String(Math.max(0, Math.min(59, newM))).padStart(2, "0");
    onChange && onChange(`${hh}:${mm}`);
  }

  return (
    <div className={`${baseCls} ${className}`}>
      <select
        disabled={disabled}
        value={h}
        onChange={(e) => setHour(parseInt(e.target.value, 10))}
        className={selCls}
        aria-label="Hora"
      >
        {hours.map((hh) => (
          <option key={hh} value={hh}>
            {String(hh).padStart(2, "0")}
          </option>
        ))}
      </select>
      <span className="font-bold">:</span>
      <select
        disabled={disabled}
        value={Math.floor(m / step) * step}
        onChange={(e) => setMinute(parseInt(e.target.value, 10))}
        className={selCls}
        aria-label="Minutos"
      >
        {minutes.map((mm) => (
          <option key={mm} value={mm}>
            {String(mm).padStart(2, "0")}
          </option>
        ))}
      </select>
    </div>
  );
}

// =====================
// COMPONENTES COMUNS
// =====================
function Header({
  auth,
  onLogout,
  tabs = [],
  tab,
  onSetTab,
}: {
  auth: any;
  onLogout: () => void;
  tabs: string[];
  tab: string;
  onSetTab: (t: string) => void;
}) {
  return (
    <div
      className="rounded-2xl p-3 text-black sticky top-0 z-10"
      style={{ background: "linear-gradient(90deg, #b9e0f9, #eaf4ff)" }}
    >
      {/* Topo */}
      <div className="flex items-center gap-3">
        <img
          src={LOGO_URL}
          alt="Paróquia"
          className="w-10 h-10 rounded-full border"
        />
        <div className="flex-1">
          <div className="text-base font-black leading-4 text-black">
            MINISTROS EXTRAORDINÁRIOS DA COMUNHÃO
          </div>
          <div className="text-xs text-gray-700">
            Paróquia Nossa Senhora das Graças · Franca-SP
          </div>
        </div>

        {auth && (
          <div className="text-[11px] text-black text-right">
            {/* Perfil e Sair como links de texto */}
            <a
              href="#perfil"
              onClick={(e) => {
                e.preventDefault();
                onSetTab && onSetTab("Perfil");
              }}
              className="mb-1 block text-xs font-bold text-blue-800 hover:underline"
            >
              Perfil
            </a>
            <div className="font-bold truncate max-w-[120px]">{auth.name}</div>
            <a
              href="#sair"
              onClick={(e) => {
                e.preventDefault();
                onLogout();
              }}
              className="text-xs text-red-600 hover:underline"
            >
              Sair
            </a>
          </div>
        )}
      </div>

      {/* Abas como TEXTO (links) */}
      {tabs.length > 0 && (
        <nav
          aria-label="Abas da aplicação"
          className="relative mt-2 -mx-3 px-3"
        >
          {/* fade nas bordas */}
          <div className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-[#b9e0f9] to-transparent" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-4 bg-gradient-to-l from-[#b9e0f9] to-transparent" />

          <div
            className="flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory scroll-pl-3 scroll-pr-3"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            {tabs.map((t) => {
              const active = tab === t;
              return (
                <a
                  key={t}
                  href={`#${encodeURIComponent(t)}`}
                  aria-current={active ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    onSetTab && onSetTab(t);
                  }}
                  className={[
                    "text-sm font-bold whitespace-nowrap snap-start transition-colors",
                    active
                      ? "text-blue-700 underline decoration-2 underline-offset-4"
                      : "text-slate-700 hover:underline hover:text-blue-700",
                  ].join(" ")}
                >
                  {t}
                </a>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}

// =====================
// =====================
// =====================
// ABA ESCALA (com "Minhas escolhas do mês" + destaques e calendário estilizado)
// =====================
function TabEscala({ auth }: { auth: any }) {
  const meKey = auth?.userKey;
  const today = todayISO();
  const [year, setYear] = useState(parseInt(today.slice(0, 4), 10));
  const [monthZero, setMonthZero] = useState(
    parseInt(today.slice(5, 7), 10) - 1
  );
  const data = useMemo(
    () => buildMonthCalendar(year, monthZero),
    [year, monthZero]
  );
  const [selected, setSelected] = useState(today);
  const grid = useMemo(
    () => buildMonthGridStrict(year, monthZero),
    [year, monthZero]
  );
  const ym = `${year}-${String(monthZero + 1).padStart(2, "0")}`;

  useEffect(() => {
    const firstIso = new Date(year, monthZero, 1).toISOString().slice(0, 10);
    if (selected.slice(0, 7) !== firstIso.slice(0, 7)) setSelected(firstIso);
  }, [year, monthZero]);

  const dow = new Date(selected + "T00:00:00").getDay();
  const header = `${DOW_LABELS[dow].toUpperCase()} - ${dateBr(selected)}`;

  const availability = loadJSON(LS_AVAILABILITY, {});
  const ministers = loadJSON(LS_MINISTERS, []);
  const nameById: any = Object.fromEntries(
    ministers.map((m: any) => [m.id, m.name || m.id])
  );
  const meName = meKey ? nameById[meKey] || auth.name : "";

  // Mapa: chave do evento -> lista de nomes confirmados (para o dia selecionado)
  const namesMap = useMemo(() => {
    const map: any = {};
    Object.keys(availability || {}).forEach((userKey) => {
      const byMonth = availability[userKey]?.[ym] || {};
      const byDate = byMonth[selected] || {};
      Object.keys(byDate).forEach((k) => {
        if (!byDate[k]) return;
        const name = nameById[userKey] || userKey;
        if (isLegacyTimeKey(k)) {
          const key = `F|${k}`; // legado "HH:MM" mapeia p/ fixo
          if (!map[key]) map[key] = [];
          map[key].push(name);
        } else {
          if (!map[k]) map[k] = [];
          map[k].push(name);
        }
      });
    });
    return map;
  }, [availability, ym, selected, nameById]);

  // Datas em que EU marquei algo (para pintar no mini-calendário)
  const myChosenDates = useMemo(() => {
    const set = new Set<string>();
    const byMonth = meKey ? availability[meKey]?.[ym] || {} : {};
    Object.entries(byMonth).forEach(([date, times]: any) => {
      if (Object.values(times || {}).some(Boolean)) set.add(date);
    });
    return set;
  }, [availability, ym, meKey]);

  // Destaque "ativo" por até 1h após o início
  // (e atualiza sozinho a cada 30s)
  const [, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const now = new Date();
  const isToday = selected === today;

  // util: HH:MM -> minutos do dia
  const hhmmToMin = (s: string) => {
    const [h, m] = s.split(":").map((n) => parseInt(n, 10));
    return (h || 0) * 60 + (m || 0);
  };

  const timesToday = (data[selected] || []).map((ev: any) => ev.time).sort();

  // regra do destaque:
  // 1) se existe algum horário que JÁ COMEÇOU há menos de 60 min,
  //    mantemos esse como destacado (o mais recente que começou).
  // 2) senão, destacamos o primeiro horário futuro.
  // 3) se não houver mais horários no dia, não destaca nenhum.
  let highlightedTime: string | null = null;
  if (isToday && timesToday.length) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const started = timesToday.filter((t) => {
      const tm = hhmmToMin(t);
      return tm <= cur && cur - tm < 60; // começou há < 60 min
    });
    if (started.length) {
      highlightedTime = started[started.length - 1]; // o mais recente
    } else {
      highlightedTime = timesToday.find((t) => hhmmToMin(t) >= cur) || null; // próximo futuro
    }
  }

  // ===== "Minhas escolhas do mês" (somente usuário logado, mês vigente)
  // Começa sempre minimizado ao entrar na aba
  const [openMine, setOpenMine] = useState(false);
  useEffect(() => {
    // garante que ao montar a aba fique fechado
    setOpenMine(false);
  }, []);
  const myMonthPicks = useMemo(() => {
    if (!meKey) return [];
    const out: any[] = [];
    const byMonth = (availability as any)?.[meKey]?.[ym] || {};
    Object.keys(data)
      .sort()
      .forEach((date) => {
        const events: any[] = (data as any)[date] || [];
        const byDate = byMonth[date] || {};
        events.forEach((ev) => {
          if (ev.kind === "extra" && isBannedExtra(ev.time, ev.name)) return;
          const key = eventKey(ev);
          const checked =
            !!byDate[key] || (ev.kind === "fixed" && !!byDate[ev.time]); // compat legado
          if (checked) {
            out.push({
              date,
              dow: new Date(date + "T00:00:00").getDay(),
              time: ev.time,
              name: ev.name || "",
              kind: ev.kind,
            });
          }
        });
      });
    out.sort((a, b) =>
      a.date === b.date
        ? a.time.localeCompare(b.time)
        : a.date.localeCompare(b.date)
    );
    return out;
  }, [meKey, availability, ym, data]);

  function pickDay(cell: any) {
    if (cell.empty) return;
    setSelected(cell.iso);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={monthZero}
          onChange={(e) => setMonthZero(parseInt(e.target.value))}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 12 }, (_, i) => i).map((i) => (
            <option key={i} value={i}>
              {monthName(i)}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(parseInt(e.target.value))}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 7 }, (_, k) => year - 3 + k).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>

      {/* QUADRO: Minhas escolhas do mês */}
      <div className="bg-white rounded-2xl border shadow">
        <button
          onClick={() => setOpenMine((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-3 text-sm font-bold hover:bg-gray-50 transition"
        >
          <span className="text-gray-700">{openMine ? "▾" : "▸"}</span>
          <span>Minhas escolhas do mês</span>
        </button>

        {openMine && (
          <div className="p-3 pt-0">
            {myMonthPicks.length === 0 ? (
              <div className="text-xs text-gray-600">
                Você ainda não selecionou horários neste mês.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="text-left p-2 border">Data</th>
                      <th className="text-left p-2 border">Dia</th>
                      <th className="text-left p-2 border">Horário</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myMonthPicks.map((r, i) => {
                      const isTodayRow = r.date === today;
                      return (
                        <tr
                          key={i}
                          className={
                            isTodayRow
                              ? "bg-amber-50 border-y-2 border-amber-300"
                              : i % 2 === 0
                              ? "bg-white"
                              : "bg-gray-50"
                          }
                        >
                          <td
                            className={`p-2 border whitespace-nowrap ${
                              isTodayRow ? "font-bold text-amber-900" : ""
                            }`}
                          >
                            {dateBr(r.date)}
                          </td>
                          <td
                            className={`p-2 border whitespace-nowrap ${
                              isTodayRow ? "font-bold text-amber-900" : ""
                            }`}
                          >
                            {DOW_LABELS[r.dow]}
                          </td>
                          <td className="p-2 border">
                            <span
                              className={`font-semibold ${
                                isTodayRow ? "text-amber-900" : ""
                              }`}
                            >
                              {r.time}
                              {r.name ? ` — ${r.name}` : ""}
                            </span>
                            {r.kind === "extra" && (
                              <span className="ml-2 text-[10px] px-1 py-0.5 rounded bg-purple-50 border border-purple-300 text-purple-800">
                                EXTRA
                              </span>
                            )}
                            {isTodayRow && (
                              <span className="ml-2 text-[10px] px-1 py-0.5 rounded bg-amber-100 border border-amber-300 text-amber-900 font-bold">
                                HOJE
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="text-[11px] text-gray-500 mt-2">
              * Mostra apenas as seleções do perfil logado para{" "}
              {monthName(monthZero).toLowerCase()} / {year}.
            </div>
          </div>
        )}
      </div>

      {/* Calendário + lista do dia selecionado */}
      <div className="bg-white rounded-2xl border shadow p-3">
        <div
          className="rounded-2xl px-4 py-3 text-white text-center font-black tracking-wide"
          style={{ background: "#1f3c88" }}
        >
          {monthName(monthZero)}
        </div>

        {/* Cabeçalho dos dias da semana com estilos pedidos */}
        <div className="grid grid-cols-7 gap-1 text-center mt-2">
          {DOW_SHORT.map((w, i) => (
            <div
              key={i}
              className={
                i === 0
                  ? "text-red-700 font-extrabold italic text-[12px]"
                  : "text-blue-700 font-extrabold italic text-[12px]"
              }
            >
              {w}
            </div>
          ))}
        </div>

        {/* Grade de dias */}
        <div className="grid grid-cols-7 gap-1 mt-1">
          {grid.map((cell: any, idx) => {
            if (cell.empty) return <div key={idx} className="h-9 rounded-xl" />;
            const dDow = new Date(cell.iso + "T00:00:00").getDay();
            const isSunday = dDow === 0;
            const isSel = cell.iso === selected;
            const isMine = myChosenDates.has(cell.iso);
            const base =
              "h-9 rounded-xl text-sm font-bold flex items-center justify-center border transition hover:shadow-sm";
            const bg = isSel
              ? "bg-blue-100 ring-2 ring-sky-300"
              : isMine
              ? "bg-orange-200 border-orange-600"
              : "bg-white";
            const txt = isSunday
              ? "text-red-700"
              : isMine
              ? "text-orange-900"
              : "text-gray-800";

            return (
              <button
                key={idx}
                onClick={() => pickDay(cell)}
                className={`${base} ${bg} ${txt}`}
                title={isMine ? "Você marcou algo neste dia" : ""}
              >
                {cell.d}
              </button>
            );
          })}
        </div>
      </div>

      {/* Lista do dia selecionado com destaque VERDE no próximo horário (mantido) */}
      <div className="space-y-2">
        <div
          className="bg-blue-50 rounded-2xl border-2"
          style={{ borderColor: "#3b82f6" }}
        >
          <div className="p-3">
            <div className="text-sm font-bold mb-2">{header}</div>

            {((data[selected] || []) as any[]).length === 0 ? (
              <div className="text-xs text-gray-500">Sem horários.</div>
            ) : (
              <div className="space-y-2">
                {(data[selected] as any[]).map((ev: any, idx: number) => {
                  const key = eventKey(ev);
                  const assigned: string[] = namesMap[key] || [];
                  const below = assigned.length < (ev.min || 0);

                  const isTodaySel = selected === today;
                  // usa o horário já decidido acima (highlightedTime)
                  const isNext = isTodaySel && ev.time === highlightedTime;
                  const isExtra = ev.kind === "extra";

                  // classes do cartão
                  const cardCls = isNext
                    ? "rounded-2xl border-2 p-3 bg-green-100"
                    : isExtra
                    ? "rounded-2xl border-2 p-3 bg-purple-50"
                    : "rounded-2xl border-2 p-3";

                  // cor da borda (verde quando destacado)
                  const borderCol = isNext
                    ? "#16a34a" // green-600
                    : isExtra
                    ? "#7c3aed" // purple-600
                    : "#3b82f6"; // blue-500

                  return (
                    <div
                      key={idx}
                      className={cardCls}
                      style={{ borderColor: borderCol }}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <div
                            className={`text-sm font-extrabold ${
                              isNext
                                ? "text-green-900"
                                : isExtra
                                ? "text-purple-900"
                                : "text-inherit"
                            }`}
                          >
                            {ev.time}
                            {ev.name ? ` - ${ev.name}` : ""}
                          </div>
                          <div
                            className={`text-xs ${
                              isNext
                                ? "text-green-700"
                                : isExtra
                                ? "text-purple-700"
                                : "text-gray-400"
                            }`}
                          >
                            —
                          </div>
                        </div>
                        <div className="text-[11px] text-gray-700">
                          Min {ev.min} • Max {ev.max}
                        </div>
                      </div>

                      {below && (
                        <div
                          className={`${
                            isNext
                              ? "text-green-700"
                              : isExtra
                              ? "text-purple-700"
                              : "text-blue-700"
                          } text-sm font-semibold mt-1`}
                        >
                          Abaixo do mínimo
                        </div>
                      )}

                      {assigned.length > 0 && (
                        <div
                          className={`mt-2 text-xs ${
                            isNext
                              ? "text-green-900"
                              : isExtra
                              ? "text-purple-900"
                              : "text-gray-800"
                          }`}
                        >
                          <div className="font-semibold mb-1">
                            Confirmados ({assigned.length}):
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {assigned.map((n: string, i: number) => (
                              <span
                                key={i}
                                className={`px-2 py-0.5 rounded-full bg-white border font-bold ${
                                  isNext
                                    ? n === (meName || "")
                                      ? "ring-2 ring-green-600 border-green-400"
                                      : "ring-1 ring-green-300 border-green-300"
                                    : n === (meName || "")
                                    ? "ring-2 ring-blue-600 border-blue-400"
                                    : "ring-1 ring-blue-300 border-blue-300"
                                }`}
                              >
                                {n}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================
// ABA DISPONIBILIDADE — clique + recorrência semanal (com janela de edição)
// =====================
function TabDisponibilidade(props: any) {
  const { auth } = props;
  const isAdmin = !!auth?.isAdmin;
  const meKey = auth?.userKey || "usuario";

  // mês/ano atualmente visíveis na UI
  const [year, setYear] = useState(parseInt(todayISO().slice(0, 4), 10));
  const [monthZero, setMonthZero] = useState(
    parseInt(todayISO().slice(5, 7), 10) - 1
  );

  // === alvo da janela: SEMPRE o mês POSTERIOR ao "hoje"
  const today = todayISO();
  const { year: targetYear, monthZero: targetMonthZero } = nextMonthOf(today);
  const targetYM = ymFromYearMonth(targetYear, targetMonthZero);

  // calendário da UI visível
  const data = useMemo(
    () => buildMonthCalendar(year, monthZero),
    [year, monthZero]
  );
  const days = useMemo(() => Object.keys(data).sort(), [data]);

  // Estado base + rascunho
  const [store, setStore] = useState(() => loadJSON(LS_AVAILABILITY, {}));
  const [draft, setDraft] = useState(store);

  // dirty flag (mantida)
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(store),
    [draft, store]
  );

  // Usuários e alvo
  const users = loadJSON(LS_MINISTERS, []).filter(
    (u: any) => u.active !== false
  );
  const [target, setTarget] = useState(meKey);

  // === CONTROLE DE JANELA
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [settings, setSettings] = useState<AvailSettings>(() =>
    loadAvailSettings()
  );
  useEffect(() => saveAvailSettings(settings), [settings]);

  // A janela “abre” para o PRÓXIMO mês (apenas)
  const windowOpenForTarget = isAvailabilityOpenForMonth(
    settings,
    targetYear,
    targetMonthZero,
    today
  );

  // Mês visível atual
  const ym = ymFromYearMonth(year, monthZero);

  // Pode editar esta visão?
  const canEditThisView = isAdmin
    ? true
    : windowOpenForTarget && ym === targetYM;

  // Controle de "alterações pendentes" (mantido)
  useEffect(() => {
    const isDirty = JSON.stringify(draft) !== JSON.stringify(store);
    localStorage.setItem(LS_DIRTY_AVAIL, isDirty ? "true" : "false");
  }, [draft, store]);
  useEffect(() => () => localStorage.removeItem(LS_DIRTY_AVAIL), []);

  // Recarrega quando muda mês/ano/target
  useEffect(() => {
    const s = loadJSON(LS_AVAILABILITY, {});
    setStore(s);
    setDraft(s);
  }, [ym, target]);
  useEffect(() => saveJSON(LS_AVAILABILITY, store), [store]);

  // === Se a janela abriu e não é admin, puxa a visão para o mês-alvo e trava os selects
  useEffect(() => {
    if (!isAdmin && windowOpenForTarget) {
      if (year !== targetYear || monthZero !== targetMonthZero) {
        setYear(targetYear);
        setMonthZero(targetMonthZero);
      }
    }
  }, [
    isAdmin,
    windowOpenForTarget,
    targetYear,
    targetMonthZero,
    year,
    monthZero,
  ]);

  // --- Calendário (seleção de dia) ---
  const [selected, setSelected] = useState(
    new Date(year, monthZero, 1).toISOString().slice(0, 10)
  );
  useEffect(() => {
    const firstIso = new Date(year, monthZero, 1).toISOString().slice(0, 10);
    if (selected.slice(0, 7) !== firstIso.slice(0, 7)) setSelected(firstIso);
  }, [year, monthZero, selected]);

  const grid = useMemo(
    () => buildMonthGridStrict(year, monthZero),
    [year, monthZero]
  );

  // Datas em que o alvo marcou algo (usa DRAFT)
  const myChosenDates = useMemo(() => {
    const set = new Set<string>();
    const byMonth = (draft as any)?.[target]?.[ym] || {};
    Object.entries(byMonth).forEach(([date, times]: any) => {
      if (Object.values(times || {}).some(Boolean)) set.add(date);
    });
    return set;
  }, [draft, target, ym]);

  // helpers locais
  const isChecked = (date: string, key: string, user: string) =>
    !!(draft as any)?.[user]?.[ym]?.[date]?.[key];

  function setFlag(date: string, key: string, user: string, value: boolean) {
    setDraft((prev) => {
      const next: any = { ...(prev || {}) };
      const byUser = { ...(next[user] || {}) };
      const byMonth = { ...(byUser[ym] || {}) };
      const byDate = { ...(byMonth[date] || {}) };

      if (value) {
        byDate[key] = true;
      } else {
        delete byDate[key];
        const m = key.match(/^F\|(\d{2}:\d{2})$/);
        if (m) delete byDate[m[1]];
      }

      byMonth[date] = byDate;
      byUser[ym] = byMonth;
      next[user] = byUser;
      return next;
    });
  }

  const toggle = (date: string, ev: any, user: string) => {
    if (!isAdmin && !canEditThisView) return;
    const key = eventKey(ev);
    const current = isChecked(date, key, user);
    setFlag(date, key, user, !current);
  };

  function eventsForDate(date: string) {
    return ((data[date] || []) as any[])
      .filter((ev) => !(ev.kind === "extra" && isBannedExtra(ev.time, ev.name)))
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  // Recorrência semanal (apenas FIXOS)
  const [recDow, setRecDow] = useState(1);
  const recTimes = useMemo(() => {
    const set = new Set<string>();
    days.forEach((date) => {
      const dow = new Date(date + "T00:00:00").getDay();
      if (dow !== recDow) return;
      (data[date] || []).forEach((ev: any) => {
        if (ev.kind === "fixed") set.add(ev.time);
      });
    });
    return Array.from(set).sort();
  }, [days, data, recDow]);
  const [recTime, setRecTime] = useState("");
  useEffect(() => {
    if (recTimes.length && !recTimes.includes(recTime))
      setRecTime(recTimes[0] || "");
  }, [recTimes, recTime]);

  function applyRecurrence(mark: boolean) {
    if (!isAdmin && !canEditThisView) return;
    if (!recTime) return;
    setDraft((prev) => {
      const next: any = { ...(prev || {}) };
      const byUser = { ...(next[target] || {}) };
      const byMonth = { ...(byUser[ym] || {}) };

      days.forEach((date) => {
        const dow = new Date(date + "T00:00:00").getDay();
        if (dow !== recDow) return;

        const evFixed = ((data[date] || []) as any[]).find(
          (ev) => ev.kind === "fixed" && ev.time === recTime
        );
        if (!evFixed) return;

        const k = eventKey(evFixed); // F|HH:MM
        const byDate = { ...(byMonth[date] || {}) };
        if (mark) byDate[k] = true;
        else {
          delete byDate[k];
          delete byDate[recTime];
        }
        byMonth[date] = byDate;
      });

      byUser[ym] = byMonth;
      next[target] = byUser;
      return next;
    });
  }

  // Ações
  function confirmDraft() {
    if (!isAdmin && !canEditThisView) return;
    setStore(draft);
  }
  function discardDraft() {
    setDraft(store);
  }

  return (
    <div className="space-y-3">
      {/* Linha de filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={monthZero}
          onChange={(e) => setMonthZero(parseInt(e.target.value))}
          disabled={!isAdmin && windowOpenForTarget}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 12 }, (_, i) => i).map((i) => (
            <option key={i} value={i}>
              {monthName(i)}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(parseInt(e.target.value))}
          disabled={!isAdmin && windowOpenForTarget}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 7 }, (_, k) => year - 3 + k).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>

        {isAdmin && (
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="ml-auto px-3 py-2 rounded-xl border text-xs bg-white"
          >
            {[{ id: meKey, name: "(Eu)" }, ...users].map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.name || u.id}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Painel ADMIN (inalterado, mas a janela sempre vale para o próximo mês) */}
      {isAdmin && (
        <div className="bg-white rounded-2xl border shadow">
          <button
            onClick={() => setAdminPanelOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-3 text-sm font-bold"
          >
            <span className="text-gray-700">{adminPanelOpen ? "▾" : "▸"}</span>
            <span>Janela de edição — Disponibilidade</span>
            <span
              className={[
                "ml-auto text-[11px] px-2 py-0.5 rounded border",
                windowOpenForTarget
                  ? "bg-green-100 border-green-300 text-green-800"
                  : "bg-amber-100 border-amber-300 text-amber-900",
              ].join(" ")}
            >
              Status (próximo mês): {windowOpenForTarget ? "ABERTA" : "FECHADA"}
            </span>
          </button>

          {adminPanelOpen && (
            <div className="p-3 pt-0 space-y-3">
              <div className="text-[11px] font-semibold">
                * A liberação sempre afeta o <b>próximo mês</b>:{" "}
                {monthName(targetMonthZero)} / {targetYear}.
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    checked={settings.mode === "auto"}
                    onChange={() => setSettings({ ...settings, mode: "auto" })}
                  />{" "}
                  Automático
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    checked={settings.mode === "manual"}
                    onChange={() =>
                      setSettings({ ...settings, mode: "manual" })
                    }
                  />{" "}
                  Manual
                </label>

                {settings.mode === "auto" && (
                  <div className="flex items-center gap-2">
                    <span>Abre</span>
                    <input
                      type="number"
                      className="w-16 border rounded-lg px-2 py-1"
                      value={settings.autoDaysBeforeEnd}
                      min={1}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          autoDaysBeforeEnd: Math.max(
                            1,
                            parseInt((e.target as any).value || "10", 10)
                          ),
                        })
                      }
                    />
                    <span>dias antes do fim do mês vigente.</span>
                  </div>
                )}

                {settings.mode === "manual" && (
                  <label className="inline-flex items-center gap-2 ml-auto">
                    <span className="font-semibold">Edição agora:</span>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings({
                          ...settings,
                          manualOpen: !settings.manualOpen,
                        })
                      }
                      className={`px-3 py-1 rounded-xl border font-bold ${
                        settings.manualOpen
                          ? "bg-green-600 text-white"
                          : "bg-gray-100"
                      }`}
                      title="Alternar edição"
                    >
                      {settings.manualOpen ? "ABERTA" : "FECHADA"}
                    </button>
                  </label>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Aviso de status para usuários (não-admin) */}
      {!isAdmin && (
        <div
          className={`rounded-xl border px-3 py-2 text-xs ${
            windowOpenForTarget
              ? "bg-green-50 border-green-300 text-green-800"
              : "bg-amber-50 border-amber-300 text-amber-900"
          }`}
        >
          {windowOpenForTarget ? (
            <>
              Edição liberada para{" "}
              <b>{monthName(targetMonthZero).toLowerCase()}</b> /{" "}
              <b>{targetYear}</b>. Você só pode editar esse mês.
            </>
          ) : (
            <>Edição fechada no momento. Você só pode visualizar.</>
          )}
        </div>
      )}

      {/* Recorrência semanal */}
      <div className="bg-white rounded-2xl border shadow p-3">
        <div className="text-xs font-bold mb-2">
          Recorrência semanal (apenas horários fixos)
        </div>
        <div className="flex items-center gap-2 text-xs">
          <select
            value={recDow}
            onChange={(e) => setRecDow(parseInt(e.target.value))}
            className="px-2 py-1 rounded-lg border"
            disabled={!isAdmin && !canEditThisView}
          >
            {DOW_LABELS.map((n, i) => (
              <option key={i} value={i}>
                {n}
              </option>
            ))}
          </select>
          <select
            value={recTime}
            onChange={(e) => setRecTime(e.target.value)}
            className="px-2 py-1 rounded-lg border"
            disabled={!isAdmin && !canEditThisView}
          >
            {recTimes.length === 0 ? (
              <option value="">Sem horários fixos</option>
            ) : (
              recTimes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))
            )}
          </select>
          <button
            onClick={() => applyRecurrence(true)}
            className="ml-auto px-3 py-1.5 rounded-xl bg-blue-600 text-white disabled:opacity-50"
            disabled={!isAdmin && !canEditThisView}
          >
            Aplicar
          </button>
          <button
            onClick={() => applyRecurrence(false)}
            className="px-3 py-1.5 rounded-xl border disabled:opacity-50"
            disabled={!isAdmin && !canEditThisView}
          >
            Limpar
          </button>
        </div>
      </div>

      {/* Barra de ações fixa */}
      <div className="sticky top-2 z-20">
        <div className="flex gap-2 bg-sky-50/80 backdrop-blur px-2 py-2 rounded-2xl border shadow-sm">
          <button
            onClick={discardDraft}
            className="px-3 py-2 rounded-xl bg-gray-200 text-gray-700 text-sm font-bold"
          >
            Descartar
          </button>
          <button
            onClick={confirmDraft}
            className="px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold disabled:opacity-50"
            disabled={(!isAdmin && !canEditThisView) || !dirty}
          >
            Confirmar
          </button>
        </div>
      </div>

      {/* Calendário compacto (mês) */}
      <div className="bg-white rounded-2xl border shadow p-3">
        <div
          className="rounded-2xl px-4 py-3 text-white text-center font-black tracking-wide"
          style={{ background: "#1f3c88" }}
        >
          {monthName(monthZero)}
        </div>

        <div className="grid grid-cols-7 gap-1 text-center mt-2">
          {DOW_SHORT.map((w, i) => (
            <div
              key={i}
              className={
                i === 0
                  ? "text-red-700 font-extrabold italic text-[12px]"
                  : "text-blue-700 font-extrabold italic text-[12px]"
              }
            >
              {w}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1 mt-1">
          {grid.map((cell: any, idx: number) => {
            if (cell.empty) return <div key={idx} className="h-9 rounded-xl" />;
            const dDow = new Date(cell.iso + "T00:00:00").getDay();
            const isSunday = dDow === 0;
            const isSel = cell.iso === selected;
            const isMine = myChosenDates.has(cell.iso);

            const base =
              "h-9 rounded-xl text-sm font-bold flex items-center justify-center border transition hover:shadow-sm";
            const bg = isSel
              ? "bg-blue-100 ring-2 ring-sky-300"
              : isMine
              ? "bg-orange-200 border-orange-600"
              : "bg-white";
            const txt = isSunday
              ? "text-red-700"
              : isMine
              ? "text-orange-900"
              : "text-gray-800";

            return (
              <button
                key={idx}
                onClick={() => setSelected(cell.iso)}
                className={`${base} ${bg} ${txt}`}
                title={isMine ? "Há seleções neste dia" : ""}
              >
                {cell.d}
              </button>
            );
          })}
        </div>
      </div>

      {/* Lista de horários do dia selecionado */}
      <div className="bg-white rounded-2xl border shadow p-3">
        <div className="text-sm font-bold mb-2">
          {DOW_LABELS[new Date(selected + "T00:00:00").getDay()].toUpperCase()}{" "}
          — {dateBr(selected)}
        </div>

        {eventsForDate(selected).length === 0 ? (
          <div className="text-xs text-gray-500">Sem horários neste dia.</div>
        ) : (
          <div className="space-y-2">
            {eventsForDate(selected).map((ev: any, i: number) => {
              const key = eventKey(ev);
              const checked =
                isChecked(selected, key, target) ||
                (ev.kind === "fixed" && isChecked(selected, ev.time, target));

              const conf = Object.keys(draft || {}).reduce((acc, userId) => {
                const byDate = (draft as any)?.[userId]?.[ym]?.[selected] || {};
                const hit =
                  !!byDate[key] || (ev.kind === "fixed" && !!byDate[ev.time]);
                return acc + (hit ? 1 : 0);
              }, 0);

              const isExtra = ev.kind === "extra";

              return (
                <label
                  key={i}
                  className={[
                    "flex items-center gap-2 p-2 rounded-xl border",
                    checked
                      ? isExtra
                        ? "bg-purple-50 border-purple-300"
                        : "bg-blue-50 border-blue-300"
                      : "bg-white",
                    !isAdmin && !canEditThisView ? "opacity-70" : "",
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(selected, ev, target)}
                    disabled={!isAdmin && !canEditThisView}
                  />
                  <span className="font-bold">
                    {ev.time}
                    {ev.name ? ` — ${ev.name}` : ""}
                  </span>
                  {isExtra && (
                    <span className="ml-2 text-[10px] px-1 py-0.5 rounded bg-purple-50 border border-purple-300 text-purple-800">
                      EXTRA
                    </span>
                  )}
                  <span className="ml-auto text-[11px] text-gray-700">
                    Min {ev.min} • Conf {conf}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// =====================
// ABA HORÁRIOS DE MISSAS (admin)
// =====================
function TabHorarios() {
  const [items, setItems] = useState(() =>
    loadJSON(LS_HORARIOS, defaultHorariosSeed())
  );
  useEffect(() => saveJSON(LS_HORARIOS, items), [items]);

  const grouped = useMemo(() => {
    const g: any[] = Array.from({ length: 7 }, () => []);
    (items as any[]).forEach((i: any) => {
      if (g[i.dow]) g[i.dow].push(i);
    });
    g.forEach((list: any[]) =>
      list.sort((a: any, b: any) => a.time.localeCompare(b.time))
    );
    return g;
  }, [items]);

  const [addTime, setAddTime] = useState<any>({
    0: "",
    1: "",
    2: "",
    3: "",
    4: "",
    5: "",
    6: "",
  });
  const [addMin, setAddMin] = useState<any>({
    0: 4,
    1: 4,
    2: 4,
    3: 4,
    4: 4,
    5: 4,
    6: 4,
  });
  const [addMax, setAddMax] = useState<any>({
    0: 12,
    1: 12,
    2: 12,
    3: 12,
    4: 12,
    5: 12,
    6: 12,
  });

  function add(dow: number) {
    const raw = addTime[dow] || "";
    if (!raw) return;
    const t = timeToCanonical(raw);
    const id = horarioId(dow, t);
    const minV = Math.max(0, parseInt(addMin[dow], 10) || 0);
    const maxV = Math.max(minV, parseInt(addMax[dow], 10) || minV);
    if ((items as any[]).some((i: any) => i.id === id)) return;
    setItems([
      ...(items as any[]),
      {
        id,
        dow,
        time: t,
        min: parseInt(addMin[dow], 10) || 4,
        max: parseInt(addMax[dow], 10) || 12,
        ativo: true,
      },
    ]);
    setAddTime({ ...addTime, [dow]: "" });
  }
  function remove(id: string) {
    setItems((items as any[]).filter((i: any) => i.id !== id));
  }
  function updateItem(id: string, patch: any) {
    setItems(
      (items as any[]).map((i: any) => {
        if (i.id !== id) return i;
        const next = { ...i, ...patch };
        const minV = Math.max(0, parseInt(next.min, 10) || 0);
        const maxV = Math.max(minV, parseInt(next.max, 10) || minV);
        return { ...next, min: minV, max: maxV };
      })
    );
  }

  function save() {
    saveJSON(LS_HORARIOS, items);
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          onClick={save}
          className="px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold"
        >
          Salvar alterações
        </button>
      </div>

      {DOW_LABELS.map((label, dow) => (
        <div
          key={dow}
          className="bg-white rounded-2xl border shadow p-3 space-y-3"
        >
          <div className="flex flex-col gap-2">
            <div className="font-bold">{label}</div>

            {/* Linha de adicionar horário (sem wrappers duplicados) */}
            <div className="flex flex-wrap items-center gap-2">
              <SmallTimePicker
                value={addTime[dow]}
                onChange={(v) => setAddTime({ ...addTime, [dow]: v })}
                step={5}
              />
              <span className="text-[11px] shrink-0">Min.</span>
              <input
                type="number"
                value={addMin[dow]}
                onChange={(e) =>
                  setAddMin({ ...addMin, [dow]: (e.target as any).value })
                }
                className="border rounded-xl px-2 py-1 w-16"
              />
              <span className="text-[11px] shrink-0">Max.</span>
              <input
                type="number"
                value={addMax[dow]}
                onChange={(e) =>
                  setAddMax({ ...addMax, [dow]: (e.target as any).value })
                }
                className="border rounded-xl px-2 py-1 w-16"
              />
              <button
                onClick={() => add(dow)}
                className="px-3 py-2 rounded-xl bg-green-600 text-white ml-auto"
              >
                Adicionar
              </button>
            </div>

            {/* Lista de horários do dia da semana */}
            <div className="space-y-2">
              {(grouped[dow] as any[]).map((i: any) => (
                <div key={i.id} className="rounded-xl border p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-bold w-16">{i.time}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] shrink-0">Min.</span>
                      <input
                        type="number"
                        value={i.min}
                        onChange={(e) =>
                          updateItem(i.id, {
                            min: parseInt((e.target as any).value, 10),
                          })
                        }
                        className="border rounded-xl px-2 py-1 w-16"
                      />
                      <span className="text-[11px] shrink-0">Max.</span>
                      <input
                        type="number"
                        value={i.max}
                        onChange={(e) =>
                          updateItem(i.id, {
                            max: parseInt((e.target as any).value, 10),
                          })
                        }
                        className="border rounded-xl px-2 py-1 w-16"
                      />
                    </div>
                    <button
                      onClick={() => remove(i.id)}
                      className="ml-auto px-2 py-1 rounded border"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// =====================
// ABA MISSAS EXTRAS (admin)
// =====================
function TabExtras() {
  const [year, setYear] = useState(parseInt(todayISO().slice(0, 4), 10));
  const [monthZero, setMonthZero] = useState(
    parseInt(todayISO().slice(5, 7), 10) - 1
  );

  // O header continua controlando o "filtro visual" (qual mês listar),
  // mas o salvamento usa o mês da DATA digitada no formulário.
  const ym = `${year}-${String(monthZero + 1).padStart(2, "0")}`;

  // STORE (persistido) + DRAFT (rascunho)
  const [store, setStore] = useState(() => loadJSON(LS_EXTRAS, {}));
  const [draft, setDraft] = useState<any>(store);

  useEffect(() => saveJSON(LS_EXTRAS, store), [store]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(store),
    [draft, store]
  );
  useEffect(() => {
    localStorage.setItem(LS_DIRTY_EXTRAS, dirty ? "true" : "false");
  }, [dirty]);
  useEffect(() => () => localStorage.removeItem(LS_DIRTY_EXTRAS), []);

  // Form
  const [name, setName] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState("");
  const [min, setMin] = useState<any>(4);
  const [max, setMax] = useState<any>(11);

  function add() {
    if (!name || !time || !date) return;

    const t = timeToCanonical(time);
    const targetYm = ymFromISODate(date); // <- MÊS DA DATA INFORMADA
    if (!targetYm) return;

    setDraft((prev: any) => {
      const next = { ...(prev || {}) };
      const list = [...(next[targetYm] || [])];
      list.push({
        name,
        date, // guarda a data exata informada
        time: t,
        min: parseInt(String(min), 10),
        max: parseInt(String(max), 10),
      });
      next[targetYm] = list;
      return next;
    });

    // Troca a visualização para o mês/ano da data adicionada (fica claro na UI)
    const tParsed = parseYm(targetYm);
    setYear(tParsed.year);
    setMonthZero(tParsed.monthZero);

    // mantém como pendente até Confirmar
  }

  function removeAt(idx: number) {
    // remoção atua no mês VISÍVEL (lista filtrada por ym)
    setDraft((prev: any) => {
      const next = { ...(prev || {}) };
      const list = [...(next[ym] || [])];
      list.splice(idx, 1);
      next[ym] = list;
      return next;
    });
  }

  function confirmAll() {
    // 1) persiste rascunho
    setStore(draft);

    // 2) sincroniza TODOS os meses tocados (presentes no draft),
    //    garantindo que o calendário de cada um seja reconstruído.
    const touched = new Set<string>(Object.keys(draft || {}));
    touched.forEach((key) => {
      const { year: y, monthZero: m0 } = parseYm(key);
      if (y > 0 && m0 >= 0) buildMonthCalendar(y, m0);
    });

    alert("Alterações confirmadas e calendários sincronizados.");
  }

  function discardAll() {
    setDraft(store);
  }

  const list = draft[ym] || [];

  return (
    <div className="space-y-3">
      {/* Filtros (mês/ano) */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={monthZero}
          onChange={(e) => setMonthZero(parseInt(e.target.value))}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 12 }, (_, i) => i).map((i) => (
            <option key={i} value={i}>
              {monthName(i)}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(parseInt(e.target.value))}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 7 }, (_, k) => year - 3 + k).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>

      {/* Barra de ações fixa (Confirmar/Descartar) */}
      <div className="sticky top-2 z-20">
        <div className="flex gap-2 bg-sky-50/80 backdrop-blur px-2 py-2 rounded-2xl border shadow-sm">
          <button
            onClick={discardAll}
            className="px-3 py-2 rounded-xl bg-gray-200 text-gray-700 text-sm font-bold"
            disabled={!dirty}
          >
            Descartar
          </button>
          <button
            onClick={confirmAll}
            className="px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold disabled:opacity-50"
            disabled={!dirty}
          >
            Confirmar
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border shadow p-3 space-y-3">
        <div className="text-sm font-bold">Missas Extras — Adicionar</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border rounded-xl px-2 py-1 w-full text-sm"
          placeholder="Nome da missa (roxo)"
        />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border rounded-xl px-2 py-1 flex-1 min-w-[150px]"
          />
          <SmallTimePicker value={time} onChange={(v) => setTime(v)} step={5} />
          <span className="text-[11px] shrink-0">Min.</span>
          <input
            type="number"
            value={min}
            onChange={(e) => setMin((e.target as any).value)}
            className="border rounded-xl px-2 py-1 w-16"
            placeholder="Min"
          />
          <span className="text-[11px] shrink-0">Max.</span>
          <input
            type="number"
            value={max}
            onChange={(e) => setMax((e.target as any).value)}
            className="border rounded-xl px-2 py-1 w-16"
            placeholder="Max"
          />
          <button
            onClick={add}
            className="px-3 py-2 rounded-xl bg-blue-600 text-white w-full"
          >
            Adicionar (fica pendente)
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border shadow p-3">
        <div className="text-sm font-bold mb-2">
          Missas Extras de {monthName(monthZero)}
          {dirty && (
            <span className="ml-2 text-[11px] px-2 py-0.5 rounded border bg-amber-50 border-amber-300 text-amber-900">
              Alterações pendentes
            </span>
          )}
        </div>
        <div className="space-y-2">
          {(list as any[]).length === 0 ? (
            <div className="text-xs text-gray-500">Nenhuma missa extra.</div>
          ) : (
            (list as any[]).map((e: any, idx: number) => (
              <div
                key={idx}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <span className="px-2 py-1 rounded-xl border bg-[#f3e8ff] border-[#8b5cf6] text-[#4c1d95]">
                  {dateBr(e.date)} {e.time} - {e.name}
                </span>
                <button
                  onClick={() => removeAt(idx)}
                  className="px-2 py-1 rounded border"
                >
                  Remover
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// =====================
// ABA MINISTROS
// =====================
function TabMinistros() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(() => loadJSON(LS_MINISTERS, []));
  useEffect(() => saveJSON(LS_MINISTERS, rows), [rows]);

  const [form, setForm] = useState<any>({
    name: "",
    email: "",
    fone: "",
    password: "123456",
    isAdmin: false,
    active: true,
  });
  const [editForm, setEditForm] = useState<any>(null);

  function add() {
    const name = (form.name || "").trim();
    if (!name) return;
    if (
      (rows as any[]).some(
        (r: any) => (r.name || "").toLowerCase() === name.toLowerCase()
      )
    )
      return;
    const id = name.toLowerCase().replace(/\s+/g, "_");
    setRows([
      ...(rows as any[]),
      {
        id,
        name,
        email: (form.email || "").trim(),
        fone: (form.fone || "").trim(),
        password: form.password || "123456",
        isAdmin: !!form.isAdmin,
        active: !!form.active,
        loginKeys: [name, form.email, form.fone].filter(Boolean),
      },
    ]);
    setForm({
      name: "",
      email: "",
      fone: "",
      password: "123456",
      isAdmin: false,
      active: true,
    });
  }
  function openEdit(row: any) {
    setEditForm({ ...row });
  }
  function saveEdit() {
    if (!editForm) return;
    const next = (rows as any[]).map((r: any) =>
      r.id === editForm.id
        ? {
            ...editForm,
            loginKeys: [editForm.name, editForm.email, editForm.fone].filter(
              Boolean
            ),
          }
        : r
    );
    setRows(next);
    setEditForm(null);
  }
  function deleteEdit() {
    if (!editForm) return;
    setRows((rows as any[]).filter((r: any) => r.id !== editForm.id));
    setEditForm(null);
  }

  const filtered = (rows as any[]).filter((r: any) =>
    [r.name, r.email, r.fone].some((v: string) =>
      (v || "").toLowerCase().includes(q.toLowerCase())
    )
  );
  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl border shadow p-3 space-y-2">
        <div className="text-sm font-bold">Novo ministro</div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <input
            value={form.name}
            onChange={(e) =>
              setForm({ ...form, name: (e.target as any).value })
            }
            placeholder="Nome (único)"
            className="border rounded-xl px-2 py-1 col-span-2"
          />
          <input
            value={form.email}
            onChange={(e) =>
              setForm({ ...form, email: (e.target as any).value })
            }
            placeholder="E-mail"
            className="border rounded-xl px-2 py-1"
          />
          <input
            value={form.fone}
            onChange={(e) =>
              setForm({ ...form, fone: (e.target as any).value })
            }
            placeholder="Telefone"
            className="border rounded-xl px-2 py-1"
          />
          <input
            value={form.password}
            onChange={(e) =>
              setForm({ ...form, password: (e.target as any).value })
            }
            placeholder="Senha (padrão 123456)"
            className="border rounded-xl px-2 py-1"
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.isAdmin}
              onChange={(e) =>
                setForm({ ...form, isAdmin: (e.target as any).checked })
              }
            />{" "}
            Admin
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) =>
                setForm({ ...form, active: (e.target as any).checked })
              }
            />{" "}
            Ativo
          </label>
          <button
            onClick={add}
            className="col-span-2 px-3 py-2 rounded-xl bg-blue-600 text-white"
          >
            Adicionar
          </button>
        </div>
      </div>
      <div className="bg-white rounded-2xl border shadow p-3">
        <div className="flex items-center gap-2 mb-2">
          <input
            value={q}
            onChange={(e) => setQ((e.target as any).value)}
            placeholder="Buscar"
            className="flex-1 border rounded-xl px-2 py-1 text-sm"
          />
        </div>
        <div className="space-y-2">
          {filtered.map((r: any) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span
                className={`${
                  r.active ? "bg-green-50 border-green-300" : "bg-gray-50"
                } px-2 py-1 rounded-xl border`}
              >
                {r.name}
              </span>
              <span className="text-[11px] text-gray-500">
                {r.email || "-"}
              </span>
              <button
                onClick={() => openEdit(r)}
                className="ml-auto px-3 py-1 rounded border"
              >
                Editar
              </button>
            </div>
          ))}
        </div>
      </div>
      {editForm && (
        <div className="bg-white rounded-2xl border shadow p-3 space-y-2">
          <div className="text-sm font-bold">Editar ministro</div>
          <input
            value={editForm.name || ""}
            onChange={(e) =>
              setEditForm({ ...editForm, name: (e.target as any).value })
            }
            className="border rounded-xl px-2 py-1 w-full text-sm"
            placeholder="Nome"
          />
          <input
            value={editForm.email || ""}
            onChange={(e) =>
              setEditForm({ ...editForm, email: (e.target as any).value })
            }
            className="border rounded-xl px-2 py-1 w-full text-sm"
            placeholder="E-mail"
          />
          <input
            value={editForm.fone || ""}
            onChange={(e) =>
              setEditForm({ ...editForm, fone: (e.target as any).value })
            }
            className="border rounded-xl px-2 py-1 w-full text-sm"
            placeholder="Telefone"
          />
          <input
            value={editForm.password || ""}
            onChange={(e) =>
              setEditForm({ ...editForm, password: (e.target as any).value })
            }
            className="border rounded-xl px-2 py-1 w-full text-sm"
            placeholder="Senha"
          />
          <div className="flex items-center gap-4 text-xs">
            <label className="flex flex-wrap items-center gap-2">
              <input
                type="checkbox"
                checked={!!editForm.isAdmin}
                onChange={(e) =>
                  setEditForm({
                    ...editForm,
                    isAdmin: (e.target as any).checked,
                  })
                }
              />{" "}
              Admin
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <input
                type="checkbox"
                checked={!!editForm.active}
                onChange={(e) =>
                  setEditForm({
                    ...editForm,
                    active: (e.target as any).checked,
                  })
                }
              />{" "}
              Ativo
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={saveEdit}
              className="px-3 py-2 rounded-xl bg-blue-600 text-white"
            >
              Salvar
            </button>
            <button
              onClick={() => setEditForm(null)}
              className="px-3 py-2 rounded-xl border"
            >
              Cancelar
            </button>
            <button
              onClick={deleteEdit}
              className="ml-auto px-3 py-2 rounded-xl border text-red-600"
            >
              Excluir
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// =====================
// =====================
// ABA RELATÓRIO (com colapsar/expandir)
// =====================
function TabRelatorio() {
  // === seguir janela de edição (usa as mesmas regras da aba Disponibilidade)
  const [settings, setSettings] = React.useState<AvailSettings>(() =>
    loadAvailSettings()
  );

  // helper: devolve {year, monthZero} do "mês-alvo" do relatório
  function computeReportMonthFromSettings(todayIso = todayISO()) {
    const y = parseInt(todayIso.slice(0, 4), 10);
    const m0 = parseInt(todayIso.slice(5, 7), 10) - 1;
    const nextY = m0 === 11 ? y + 1 : y;
    const nextM0 = (m0 + 1) % 12;

    // Se a janela do PRÓXIMO mês está aberta -> relatório mira o próximo mês
    const openNext = isAvailabilityOpenForMonth(
      settings,
      nextY,
      nextM0,
      todayIso
    );
    return openNext
      ? { year: nextY, monthZero: nextM0 }
      : { year: y, monthZero: m0 };
  }

  // Estado: ano/mês que o relatório está mostrando
  const initialReport = computeReportMonthFromSettings();
  const [year, setYear] = React.useState(initialReport.year);
  const [monthZero, setMonthZero] = React.useState(initialReport.monthZero);

  // Auto-follow: o relatório acompanha a janela automaticamente
  // até o usuário mudar manualmente o mês/ano nos selects.
  const [autoFollow, setAutoFollow] = React.useState(true);

  // (opcional) recarrega settings ao montar o componente
  React.useEffect(() => {
    setSettings(loadAvailSettings());
  }, []);

  // Sincroniza settings quando eles mudarem em outro lugar (ex.: aba Disponibilidade)
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_AVAIL_SETTINGS) {
        try {
          setSettings(JSON.parse(e.newValue || "{}"));
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Sempre que os settings mudarem, se autoFollow estiver ativo,
  // o relatório “migra” para o mês-alvo correto.
  React.useEffect(() => {
    if (!autoFollow) return;
    const target = computeReportMonthFromSettings();
    if (target.year !== year || target.monthZero !== monthZero) {
      setYear(target.year);
      setMonthZero(target.monthZero);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const ym = `${year}-${String(monthZero + 1).padStart(2, "0")}`;

  // dados base
  const availability = loadJSON(LS_AVAILABILITY, {});
  const ministers = loadJSON(LS_MINISTERS, []);
  const cal = React.useMemo(
    () => buildMonthCalendar(year, monthZero),
    [year, monthZero]
  );

  // ---- quadro 1: Seleções por ministro
  const rows = (ministers as any[])
    .map((m: any) => {
      const byMonth = (availability as any)[m.id]?.[ym] || {};
      let cnt = 0;
      Object.values(byMonth).forEach((timesObj: any) => {
        Object.values(timesObj || {}).forEach((v: any) => {
          if (v) cnt++;
        });
      });
      return { id: m.id, name: m.name || m.id, count: cnt };
    })
    .sort((a: any, b: any) => b.count - a.count);

  // ---- quadro 2: Horários abaixo do mínimo
  function countAssigned(date: string, ev: any) {
    const key = eventKey(ev); // "F|HH:MM" ou "X|HH:MM|Nome"
    let total = 0;
    Object.keys(availability || {}).forEach((userId) => {
      const byDate = (availability as any)[userId]?.[ym]?.[date] || {};
      const hit = !!byDate[key] || (ev.kind === "fixed" && !!byDate[ev.time]); // compat legada "HH:MM"
      if (hit) total++;
    });
    return total;
  }

  const shortages = React.useMemo(() => {
    const list: any[] = [];
    Object.keys(cal)
      .sort()
      .forEach((date) => {
        const dow = new Date(date + "T00:00:00").getDay();
        ((cal as any)[date] || []).forEach((ev: any) => {
          const assigned = countAssigned(date, ev);
          const min = ev.min || 0;
          if (assigned < min) {
            list.push({
              date,
              dow,
              time: ev.time,
              name: ev.name || "",
              min,
              assigned,
              missing: Math.max(0, min - assigned),
              kind: ev.kind,
            });
          }
        });
      });
    list.sort((a, b) =>
      a.date === b.date
        ? a.time.localeCompare(b.time)
        : a.date.localeCompare(b.date)
    );
    return list;
  }, [cal, availability, ym]);

  // abrir/fechar quadros
  const [openSelecoes, setOpenSelecoes] = React.useState(true);
  const [openFaltas, setOpenFaltas] = React.useState(true);

  return (
    <div className="space-y-3">
      {/* Filtros (mês/ano) + chave "seguir janela" */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={monthZero}
          onChange={(e) => {
            setAutoFollow(false);
            setMonthZero(parseInt(e.target.value));
          }}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 12 }, (_, i) => i).map((i) => (
            <option key={i} value={i}>
              {monthName(i)}
            </option>
          ))}
        </select>

        <select
          value={year}
          onChange={(e) => {
            setAutoFollow(false);
            setYear(parseInt(e.target.value));
          }}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 7 }, (_, k) => year - 3 + k).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>

        <label className="ml-auto inline-flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={autoFollow}
            onChange={(e) => {
              const on = (e.target as any).checked;
              setAutoFollow(on);
              if (on) {
                // ao reativar, alinhar imediatamente ao mês-alvo
                const target = computeReportMonthFromSettings();
                setYear(target.year);
                setMonthZero(target.monthZero);
              }
            }}
          />
          Seguir automaticamente a janela de edição
        </label>
      </div>

      {/* Quadro 1: Seleções por Ministro */}
      <div className="bg-white rounded-2xl border shadow">
        <button
          onClick={() => setOpenSelecoes((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-3 text-sm font-bold"
        >
          <span className="text-gray-700">{openSelecoes ? "▾" : "▸"}</span>
          <span>Seleções por Ministro</span>
        </button>

        {openSelecoes && (
          <div className="p-3 pt-0">
            <div className="space-y-1">
              {rows.map((r: any) => (
                <div
                  key={r.id}
                  className={`flex items-center justify-between text-sm ${
                    r.count > 0 ? "text-green-700" : "text-red-700"
                  }`}
                >
                  <span
                    className={`px-2 py-0.5 rounded ${
                      r.count > 0
                        ? "bg-green-50 border border-green-300"
                        : "bg-red-50 border border-red-300"
                    }`}
                  >
                    {r.name}
                  </span>
                  <span className="font-bold">{r.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Quadro 2: Horários abaixo do mínimo */}
      <div className="bg-white rounded-2xl border shadow">
        <button
          onClick={() => setOpenFaltas((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-3 text-sm font-bold"
        >
          <span className="text-gray-700">{openFaltas ? "▾" : "▸"}</span>
          <span>Horários abaixo do mínimo</span>
        </button>

        {openFaltas && (
          <div className="p-3 pt-0">
            {shortages.length === 0 ? (
              <div className="text-xs text-green-700 font-semibold">
                Todos os horários atingiram o mínimo. 🙌
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="text-left p-2 border">Data</th>
                      <th className="text-left p-2 border">Dia</th>
                      <th className="text-left p-2 border">Horário</th>
                      <th className="text-center p-2 border">Min</th>
                      <th className="text-center p-2 border">Conf</th>
                      <th className="text-center p-2 border">Falta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortages.map((s, i) => (
                      <tr
                        key={i}
                        className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}
                      >
                        <td className="p-2 border whitespace-nowrap">
                          {dateBr(s.date)}
                        </td>
                        <td className="p-2 border whitespace-nowrap">
                          {DOW_LABELS[s.dow]}
                        </td>
                        <td className="p-2 border">
                          <span className="font-semibold">
                            {s.time}
                            {s.name ? ` — ${s.name}` : ""}
                          </span>
                          {s.kind === "extra" && (
                            <span className="ml-2 text-[10px] px-1 py-0.5 rounded bg-purple-50 border border-purple-300 text-purple-800">
                              EXTRA
                            </span>
                          )}
                        </td>
                        <td className="p-2 border text-center font-bold text-gray-700">
                          {s.min}
                        </td>
                        <td className="p-2 border text-center font-bold text-gray-700">
                          {s.assigned}
                        </td>
                        <td className="p-2 border text-center font-extrabold text-red-700">
                          {s.missing}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="text-[11px] text-gray-500 mt-2">
              * “Conf” = confirmações registradas em Disponibilidade. “Falta” =
              Min − Conf.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =====================
// ABA EXPORTAR (PDF + backup JSON)
// =====================
function TabExportar({ auth }: { auth: any }) {
  const [year, setYear] = useState(parseInt(todayISO().slice(0, 4), 10));
  const [monthZero, setMonthZero] = useState(
    parseInt(todayISO().slice(5, 7), 10) - 1
  );
  const ym = `${year}-${String(monthZero + 1).padStart(2, "0")}`;
  const cal = useMemo(
    () => buildMonthCalendar(year, monthZero),
    [year, monthZero]
  );
  const ministers = loadJSON(LS_MINISTERS, []).filter(
    (m: any) => m.active !== false
  );
  const availability = loadJSON(LS_AVAILABILITY, {});
  const isAdmin = !!auth?.isAdmin;
  const monthLabel = `${monthName(monthZero)} ${year}`;

  // Horários fixos ativos disponíveis (sem 08:30 e sem 11:00 na listagem geral)
  const allTimes = useMemo(() => {
    const hs = loadJSON(LS_HORARIOS, defaultHorariosSeed()).filter(
      (h: any) => h.ativo
    );
    return Array.from(new Set((hs as any[]).map((h) => h.time)))
      .filter((t: any) => t !== "08:30" && t !== "11:00")
      .sort();
  }, []);

  const [selTimes, setSelTimes] = useState(() => {
    const defaults = ["06:30", "11:30", "19:00"].filter((t: any) =>
      (allTimes as any[]).includes(t)
    );
    return defaults.length ? defaults : (allTimes as any[]).slice(0, 3);
  });
  const [includeExtras, setIncludeExtras] = useState(false);
  const [includeSunday0830, setIncludeSunday0830] = useState(false);
  const [includeSunday1100, setIncludeSunday1100] = useState(false);

  const toggleTime = (t: string) =>
    setSelTimes((prev) => {
      const updated = (prev as any[]).includes(t)
        ? (prev as any[]).filter((x) => x !== t)
        : [...(prev as any[]), t];
      return [...updated].sort();
    });
  const selectAll = () => {
    setSelTimes(allTimes as any);
    setIncludeExtras(true);
    setIncludeSunday0830(true);
    setIncludeSunday1100(true);
  };
  const clearAll = () => {
    setSelTimes([]);
    setIncludeExtras(false);
    setIncludeSunday0830(false);
    setIncludeSunday1100(false);
  };

  // Lê nomes marcados para uma data+hora (fixo) ou data+hora+nome (extra)
  function ministersFor(date: string, time: string, name?: string) {
    const names: string[] = [];
    (ministers as any[]).forEach((m: any) => {
      const byDate = (availability as any)?.[m.id]?.[ym]?.[date] || {};
      const fixedKey = `F|${time}`;
      const extraKey = name ? `X|${time}|${name}` : null;

      const markedFixed = !!(byDate[fixedKey] || byDate[time]); // compat legado
      const markedExtra = extraKey ? !!byDate[extraKey] : false;

      if (markedFixed || markedExtra) {
        names.push((m.name || m.id).toUpperCase());
      }
    });
    return names;
  }

  // Linhas para um horário fixo ao longo do mês
  function rowsForTime(time: string) {
    const rows: any[] = [];
    Object.keys(cal)
      .sort()
      .forEach((date) => {
        const events = (cal as any)[date] || [];
        // pego apenas FIXO deste horário
        if (
          (events as any[]).some(
            (ev: any) => ev.time === time && ev.kind !== "extra"
          )
        ) {
          const dow = new Date(date + "T00:00:00").getDay();
          const names = ministersFor(date, time);
          rows.push({ date, dow, names });
        }
      });
    return rows;
  }

  function rowsForSundayTime(time: string) {
    const rows: any[] = [];
    Object.keys(cal)
      .sort()
      .forEach((date) => {
        const dow = new Date(date + "T00:00:00").getDay();
        if (dow !== 0) return;
        const events = (cal as any)[date] || [];
        if (
          (events as any[]).some(
            (ev: any) => ev.time === time && ev.kind !== "extra"
          )
        ) {
          const names = ministersFor(date, time);
          rows.push({ date, dow, names });
        }
      });
    return rows;
  }

  function extraRows() {
    const rows: any[] = [];
    Object.keys(cal)
      .sort()
      .forEach((date) => {
        ((cal as any)[date] || []).forEach((ev: any) => {
          if (ev.kind === "extra") {
            if (isBannedExtra(ev.time, ev.name)) return; // ⬅ aqui
            const dow = new Date(date + "T00:00:00").getDay();
            const names = ministersFor(date, ev.time, ev.name);
            rows.push({ date, dow, time: ev.time, name: ev.name || "", names });
          }
        });
      });
    return rows;
  }

  function escapeHtml(s: string) {
    return String(s || "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c] as string)
    );
  }

  function buildPrintHtml(options: {
    times: string[];
    includeExtras: boolean;
    includeSunday0830: boolean;
    includeSunday1100: boolean;
  }) {
    const {
      times,
      includeExtras: incEx,
      includeSunday0830: inc0830,
      includeSunday1100: inc1100,
    } = options;

    const title = "ESCALA DE MINISTROS EXTRAORDINÁRIOS DA EUCARISTIA";

    function trDateRow(date: string, dow: number, names: string[]) {
      const list = (names && names.length ? names : []).join(" • ");
      return `<tr>
        <td class="c-blue">${escapeHtml(dateBr(date))}</td>
        <td class="c-blue">${escapeHtml(DOW_LABELS[dow])}</td>
        <td><div class="fit-text">${escapeHtml(list)}</div></td>
      </tr>`;
    }

    function table(
      sectionTitle: string,
      head3: string | null,
      rowsHtml: string
    ) {
      return `
        ${head3 ? `<div class="sub">${escapeHtml(head3)}</div>` : ""}
        <table class="zebra">
          <thead>
            <tr>
              <th class="w-date">Data</th>
              <th class="w-dow">Dia</th>
              <th>Ministros</th>
            </tr>
          </thead>
          <tbody>${
            rowsHtml || '<tr><td colspan="3" class="empty">Sem itens</td></tr>'
          }</tbody>
        </table>
      `;
    }

    function page(sectionTitle: string, inner: string) {
      return `
        <section class="page upper">
          <div class="banner">
            <div class="banner-title">${title}</div>
            <div class="banner-sub">${escapeHtml(monthLabel)} — ${escapeHtml(
        sectionTitle
      )}</div>
          </div>
          ${inner}
        </section>
      `;
    }

    // Seções por horário fixo
    let sectionsHtml = "";
    (times || []).forEach((t) => {
      const rows = rowsForTime(t);
      const rowsHtml = rows
        .map((r) => trDateRow(r.date, r.dow, r.names))
        .join("");
      sectionsHtml += page(
        `Missas — ${t}`,
        table(`Missas — ${t}`, null, rowsHtml)
      );
    });

    // Página combinada (Dom 08:30 + Dom 11:00 + Extras)
    const doCombined = inc0830 && inc1100 && incEx;

    if (doCombined) {
      const r0830 = rowsForSundayTime("08:30");
      const r1100 = rowsForSundayTime("11:00");
      const rextra = extraRows();

      const html0830 = r0830
        .map((r) => trDateRow(r.date, r.dow, r.names))
        .join("");
      const html1100 = r1100
        .map((r) => trDateRow(r.date, r.dow, r.names))
        .join("");

      const extrasTrs = rextra
        .map((r) => {
          const names = (r.names && r.names.length ? r.names : []).join(" • ");
          const label = `<strong>${escapeHtml(r.time)}</strong> — ${escapeHtml(
            r.name || "Missa Extra"
          )}`;
          return `<tr>
            <td class="c-blue">${escapeHtml(dateBr(r.date))}</td>
            <td class="c-blue">${escapeHtml(DOW_LABELS[r.dow])}</td>
            <td><div class="fit-text">${label} — ${escapeHtml(names)}</div></td>
          </tr>`;
        })
        .join("");

      const inner =
        table("Domingo 08:30", "Domingo — 08:30", html0830) +
        table("Domingo 11:00", "Domingo — 11:00", html1100) +
        table("Missas Extras", "Missas Extras", extrasTrs);

      sectionsHtml += page(
        "Dom. 08:30 + Dom. 11:00 + Extras",
        `<div class="combined">${inner}</div>`
      );
    } else {
      if (inc0830) {
        const r0830 = rowsForSundayTime("08:30");
        const rowsHtml = r0830
          .map((r) => trDateRow(r.date, r.dow, r.names))
          .join("");
        sectionsHtml += page(
          "Domingo — 08:30",
          table("Domingo 08:30", null, rowsHtml)
        );
      }
      if (inc1100) {
        const r1100 = rowsForSundayTime("11:00");
        const rowsHtml = r1100
          .map((r) => trDateRow(r.date, r.dow, r.names))
          .join("");
        sectionsHtml += page(
          "Domingo — 11:00",
          table("Domingo 11:00", null, rowsHtml)
        );
      }
      if (incEx) {
        const rextra = extraRows();
        const extrasTrs = rextra
          .map((r) => {
            const names = (r.names && r.names.length ? r.names : []).join(
              " • "
            );
            const label = `<strong>${escapeHtml(
              r.time
            )}</strong> — ${escapeHtml(r.name || "Missa Extra")}`;
            return `<tr>
              <td class="c-blue">${escapeHtml(dateBr(r.date))}</td>
              <td class="c-blue">${escapeHtml(DOW_LABELS[r.dow])}</td>
              <td><div class="fit-text">${label} — ${escapeHtml(
              names
            )}</div></td>
            </tr>`;
          })
          .join("");
        sectionsHtml += page(
          "Missas Extras",
          table("Missas Extras", null, extrasTrs)
        );
      }
    }

    const html = `
  <!doctype html>
  <html>
  <head>
  <meta charset="utf-8"/>
  <title>Exportar — ${escapeHtml(monthLabel)}</title>
  <style>
    @page { size: A4 portrait; margin: 10mm; }
    :root{ --blue:#1f3c88; --blue2:#2563eb; --border:#c7c7c7; --zebra:#f2f2f2; }
    *{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#111; }
    .upper * { text-transform: uppercase; font-weight: 700; }
    .page { page-break-after: always; }
    .banner{ text-align:center; margin:0 0 6mm; }
    .banner-title{ font-size:14pt; color:white; background:linear-gradient(90deg, var(--blue), var(--blue2)); padding:4px 8px; border-radius:8px; display:inline-block; }
    .banner-sub{ font-size:10pt; color:var(--blue2); margin-top:4px; }
    .sub{ font-size:10pt; color:#111; font-weight:800; margin: 6px 0 2px; }
    table { width:100%; border-collapse: collapse; font-size:9pt; table-layout: fixed; margin-top: 2px; }
    th, td { border:1px solid var(--border); padding:3px 4px; vertical-align:top; line-height: 1.1; letter-spacing: .1px; }
    thead th { background:#e5e5e5; color:#111; }
    .w-date{ width:16%; }
    .w-dow{ width:17%; }
    .zebra tbody tr:nth-child(odd) td{ background: var(--zebra); }
    .zebra tbody tr:nth-child(even) td{ background: #ffffff; }
    .empty { text-align:center; color:#6b7280; font-weight:700; }
    .c-blue{ color:#1e3a8a; }
    .fit-text{ white-space: nowrap; overflow:hidden; text-overflow: ellipsis; display:block; }
    .combined { page-break-inside: avoid; }
    .combined table { page-break-inside: avoid; font-size: 8.5pt; }
    .combined .fit-text { font-size: 8.5pt; }
  </style>
  </head>
  <body>
    ${sectionsHtml}
    <script>
  function fit(){
    var els = document.querySelectorAll('.fit-text');
    els.forEach(function(el){
      var size = 9;
      el.style.fontSize = size+'pt';
      var tries=0;
      while(el.scrollWidth > el.clientWidth && size > 6 && tries<30){
        size -= 0.25;
        el.style.fontSize = size+'pt';
        tries++;
      }
    });
    // remove quebra da última .page
    var pages = document.querySelectorAll('.page');
    if (pages.length) pages[pages.length - 1].style.pageBreakAfter = 'auto';
    window.print();
  }
  window.onload = function(){ setTimeout(fit, 0); };
</script>

  </body>
  </html>`;
    return html;
  }

  function openPrint() {
    const html = buildPrintHtml({
      times: selTimes as any,
      includeExtras,
      includeSunday0830,
      includeSunday1100,
    });
    const w = window.open("", "_blank");
    if (!w) {
      alert("Bloqueado pelo navegador. Permita pop-ups para imprimir.");
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  // Exportação JSON (backup) — só admin
  function downloadJson(name: string, data: string) {
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  const dump = () => {
    const obj = {
      horarios: loadJSON(LS_HORARIOS, []),
      extras: loadJSON(LS_EXTRAS, {}),
      availability: loadJSON(LS_AVAILABILITY, {}),
      ministers: loadJSON(LS_MINISTERS, []),
    };
    downloadJson(
      `backup_escala_${todayISO()}.json`,
      JSON.stringify(obj, null, 2)
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={monthZero}
          onChange={(e) => setMonthZero(parseInt(e.target.value))}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 12 }, (_, i) => i).map((i) => (
            <option key={i} value={i}>
              {monthName(i)}
            </option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(parseInt(e.target.value))}
          className="px-3 py-2 rounded-xl border text-xs font-bold bg-white"
        >
          {Array.from({ length: 7 }, (_, k) => year - 3 + k).map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <button
          onClick={openPrint}
          className="ml-auto px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold"
        >
          Imprimir / Salvar PDF (A4)
        </button>
      </div>

      <div className="bg-white rounded-2xl border shadow p-3">
        <div className="text-sm font-bold mb-2">
          Horários / Páginas a incluir no PDF
        </div>
        <div className="flex flex-wrap gap-2">
          {(allTimes as any[]).map((t: string) => (
            <label
              key={t}
              className={`px-3 py-1.5 rounded-xl border text-sm inline-flex items-center ${
                (selTimes as any[]).includes(t)
                  ? "bg-blue-50 border-blue-300 text-blue-900"
                  : "bg-white"
              }`}
            >
              <input
                type="checkbox"
                className="mr-2"
                checked={(selTimes as any[]).includes(t)}
                onChange={() => toggleTime(t)}
              />
              {t}
            </label>
          ))}
          <label
            className={`px-3 py-1.5 rounded-xl border text-sm inline-flex items-center ${
              includeSunday0830
                ? "bg-blue-50 border-blue-300 text-blue-900"
                : "bg-white"
            }`}
          >
            <input
              type="checkbox"
              className="mr-2"
              checked={includeSunday0830}
              onChange={(e) => setIncludeSunday0830((e.target as any).checked)}
            />
            Domingo 08:30
          </label>
          <label
            className={`px-3 py-1.5 rounded-xl border text-sm inline-flex items-center ${
              includeSunday1100
                ? "bg-blue-50 border-blue-300 text-blue-900"
                : "bg-white"
            }`}
          >
            <input
              type="checkbox"
              className="mr-2"
              checked={includeSunday1100}
              onChange={(e) => setIncludeSunday1100((e.target as any).checked)}
            />
            Domingo 11:00
          </label>
          <label
            className={`px-3 py-1.5 rounded-xl border text-sm inline-flex items-center ${
              includeExtras
                ? "bg-blue-50 border-blue-300 text-blue-900"
                : "bg-white"
            }`}
          >
            <input
              type="checkbox"
              className="mr-2"
              checked={includeExtras}
              onChange={(e) => setIncludeExtras((e.target as any).checked)}
            />
            Missas Extras
          </label>
        </div>
        <div className="mt-2 flex gap-2">
          <button onClick={selectAll} className="px-3 py-1.5 rounded-xl border">
            Selecionar todos
          </button>
          <button onClick={clearAll} className="px-3 py-1.5 rounded-xl border">
            Limpar
          </button>
        </div>
      </div>

      {isAdmin && (
        <div className="bg-white rounded-2xl border shadow p-4 text-sm">
          <div className="font-bold mb-2">Backup (somente administrador)</div>
          <button
            onClick={dump}
            className="px-3 py-2 rounded-xl bg-gray-800 text-white"
          >
            Exportar backup JSON
          </button>
        </div>
      )}
    </div>
  );
}

// =====================
// APP ROOT (mostra Login ou as Abas)
// =====================
// =====================
// LOGIN (tela simples, usa LS_MINISTERS) — COM "Permanecer conectado"
// =====================
function Login({ onOk }: { onOk: (auth: any, remember: boolean) => void }) {
  const [user, setUser] = React.useState("");
  const [pass, setPass] = React.useState("");
  const [remember, setRemember] = React.useState(false); // << novo
  const [error, setError] = React.useState<string | null>(null);

  async function doLogin(e: React.FormEvent) {
  e.preventDefault();
  setError(null);

  if (!user || !pass) {
    setError("Preencha usuário e senha");
    return;
  }

  try {
    setLoading(true);

    // chave digitada (nome ou e-mail)
    const key = user.trim();

    // Busca UM ministro cujo name == key OU email == key
    const { data: u, error } = await supabase
      .from('ministers')
      .select('id,name,email,phone,password,is_admin,active,login_keys')
      .or(`email.eq.${key},name.eq.${key}`)
      .maybeSingle();

    if (error) throw error;

    if (!u) {
      setError("Usuário não encontrado");
      return;
    }
    if (!u.active) {
      setError("Usuário inativo");
      return;
    }
    if (pass !== (u.password ?? "")) {
      setError("Senha incorreta");
      return;
    }

    // OK: devolve para o App os dados do usuário autenticado
    onOk(
      {
        id: u.id,
        name: u.name,
        loginKeys: u.login_keys ?? [],
        isAdmin: !!u.is_admin,
        active: !!u.active,
        phone: u.phone ?? null,
      },
      remember
    );
  } catch (err: any) {
    setError(err?.message ?? String(err));
  } finally {
    setLoading(false);
  }
}

  return (
    <div className="max-w-[390px] mx-auto">
      <div className="bg-white rounded-2xl border shadow p-4">
        <div className="text-center mb-3">
          <img
            src={LOGO_URL}
            alt="Paróquia"
            className="w-32 h-32 rounded-full border mx-auto"
          />
          <div className="mt-2 text-sm font-black">
            MINISTROS EXTRAORDINÁRIOS DA COMUNHÃO
          </div>
          <div className="text-[11px] text-gray-600">
            Paróquia Nossa Senhora das Graças · Franca-SP
          </div>
        </div>

        <form onSubmit={doLogin} className="space-y-2">
          <input
            value={user}
            onChange={(e) => setUser((e.target as any).value)}
            placeholder="Usuário, e-mail ou telefone"
            className="w-full border rounded-xl px-3 py-2 text-sm"
          />
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass((e.target as any).value)}
            placeholder="Senha"
            className="w-full border rounded-xl px-3 py-2 text-sm"
          />

          {/** ⬇⬇⬇ AQUI é “entre senha/erro e o botão Entrar” */}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember((e.target as any).checked)}
            />
            Permanecer conectado
          </label>
          {/** ⬆⬆⬆ */}

          {error && (
            <div className="text-xs text-red-700 font-semibold">{error}</div>
          )}

          <button
            type="submit"
            className="w-full px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold"
          >
            Entrar
          </button>

          {/* Citação de Santo Agostinho */}
          <div className="text-center mt-3 text-gray-700 text-sm italic">
            “Ó sacramento de piedade, ó sinal de unidade, ó vínculo de caridade!
            Quem quer viver tem onde viver, tem de que viver. Aproxime-se,
            creia, entre a comunhão para ser vivificado.”
            <br />
            <span className="font-bold not-italic">Santo Agostinho</span>
          </div>
        </form>
      </div>
    </div>
  );
}

// =====================
// PERFIL (editar meus dados)
// =====================
function TabPerfil({
  auth,
  onAuthChange,
}: {
  auth: any;
  onAuthChange: (a: any) => void;
}) {
  const [form, setForm] = React.useState<any>({
    name: auth?.name || "",
    email: auth?.email || "",
    fone: auth?.fone || "",
    password: "",
  });
  const [saved, setSaved] = React.useState(false);

  function saveProfile() {
    const ministers = loadJSON(LS_MINISTERS, []);
    const idx = (ministers as any[]).findIndex(
      (m: any) => m.id === auth.userKey
    );
    if (idx === -1) return;

    const next = [...(ministers as any[])];
    const curr = { ...next[idx] };

    const name = (form.name || "").trim();
    const email = (form.email || "").trim();
    const fone = (form.fone || "").trim();

    // 1) bloquear “sumir com o login”
    const newKeys = [name || curr.name, email, fone].filter(Boolean);
    if (newKeys.length === 0) {
      alert(
        "Você precisa manter pelo menos 1 forma de login (Nome, E-mail ou Telefone)."
      );
      return;
    }

    curr.name = name || curr.name; // nome pode mudar, mas nunca ficar vazio
    curr.email = email;
    curr.fone = fone;

    // 2) senha: só troca se veio algo
    if ((form.password || "").trim()) curr.password = form.password.trim();

    // 3) atualiza as chaves de login
    curr.loginKeys = [curr.name, curr.email, curr.fone].filter(Boolean);

    next[idx] = curr;
    saveJSON(LS_MINISTERS, next);

    const newAuth = {
      ...auth,
      name: curr.name,
      email: curr.email,
      fone: curr.fone,
    };
    saveJSON(LS_AUTH, newAuth);
    onAuthChange(newAuth);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="bg-white rounded-2xl border shadow p-3 space-y-2">
      <div className="text-sm font-bold">Meu perfil</div>
      <input
        value={form.name}
        onChange={(e) => setForm({ ...form, name: (e.target as any).value })}
        placeholder="Nome"
        className="border rounded-xl px-3 py-2 w-full text-sm"
      />
      <input
        value={form.email}
        onChange={(e) => setForm({ ...form, email: (e.target as any).value })}
        placeholder="E-mail"
        className="border rounded-xl px-3 py-2 w-full text-sm"
      />
      <input
        value={form.fone}
        onChange={(e) => setForm({ ...form, fone: (e.target as any).value })}
        placeholder="Telefone"
        className="border rounded-xl px-3 py-2 w-full text-sm"
      />
      <input
        type="password"
        value={form.password}
        onChange={(e) =>
          setForm({ ...form, password: (e.target as any).value })
        }
        placeholder="Nova senha (opcional)"
        className="border rounded-xl px-3 py-2 w-full text-sm"
      />

      <div className="flex gap-2">
        <button
          onClick={saveProfile}
          className="px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold"
        >
          Salvar alterações
        </button>
        {saved && (
          <span className="text-xs text-green-700 font-semibold self-center">
            Salvo!
          </span>
        )}
      </div>

      <div className="text-[11px] text-gray-500">
        * Alterar a senha é opcional; deixe em branco para manter.
      </div>
    </div>
  );
}
function Shell({ auth, onLogout }: { auth: any; onLogout: () => void }) {
  // >>>> NOVO: estado local para refletir edições do perfil imediatamente
  const [authView, setAuthView] = useState<any>(auth);
  useEffect(() => {
    // se trocar de usuário no App, sincroniza o espelho
    setAuthView(auth);
  }, [auth]);

  const isAdmin = !!authView?.isAdmin;

  // Abas disponíveis (admin vê mais)
  const tabsUser = ["Escala", "Disponibilidade", "Exportar"] as const;
  const tabsAdmin = [
    "Escala",
    "Disponibilidade",
    "Horários de Missas",
    "Missas Extras",
    "Ministros",
    "Relatório",
    "Exportar",
  ] as const;
  const tabs = (isAdmin ? tabsAdmin : tabsUser) as string[];

  // Estado da aba atual — inicia SEMPRE na primeira da lista
  const [tab, setTab] = useState<string>(tabs[0]);

  // Se o conjunto de abas mudar (ex.: virou admin), garante que a aba atual exista
  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  return (
    <div className="min-h-screen bg-sky-50 p-3">
      <div className="max-w-[390px] mx-auto space-y-3">
        <Header
          auth={authView}
          onLogout={onLogout}
          tabs={tabs}
          tab={tab}
          onSetTab={(nextTab) => {
            // Bloqueio se houver rascunho em Disponibilidade
            if (tab === "Disponibilidade") {
              const dirty = localStorage.getItem(LS_DIRTY_AVAIL) === "true";
              if (dirty) {
                alert(
                  "Você tem alterações pendentes em Disponibilidade.\n" +
                    "Por favor, clique em Confirmar ou Descartar antes de sair desta aba."
                );
                return;
              }
            }

            // Bloqueio se houver rascunho em Missas Extras
            if (tab === "Missas Extras") {
              const dirtyEx = localStorage.getItem(LS_DIRTY_EXTRAS) === "true";
              if (dirtyEx) {
                alert(
                  "Você tem alterações pendentes em Missas Extras.\n" +
                    "Só é possível mudar de aba após Confirmar ou Descartar a adição/remoção."
                );
                return;
              }
            }

            setTab(nextTab);
          }}
        />

        {/* as abas recebem authView (não o auth “original”) */}
        {tab === "Escala" && <TabEscala auth={authView} />}
        {tab === "Disponibilidade" && <TabDisponibilidade auth={authView} />}
        {tab === "Horários de Missas" && isAdmin && <TabHorarios />}
        {tab === "Missas Extras" && isAdmin && <TabExtras />}
        {tab === "Ministros" && isAdmin && <TabMinistros />}
        {tab === "Relatório" && isAdmin && <TabRelatorio />}
        {tab === "Exportar" && <TabExportar auth={authView} />}

        {tab === "Perfil" && (
          <TabPerfil
            auth={authView}
            onAuthChange={(newAuth: any) => {
              // Atualiza o espelho para refletir nome/email/telefone no Header
              setAuthView((prev: any) => ({ ...prev, ...newAuth }));
              // Persiste para manter consistência caso recarregue a página
              saveJSON(LS_AUTH, { ...authView, ...newAuth });
            }}
          />
        )}
      </div>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState(() => loadJSON(LS_AUTH, null));

  // persiste toda vez que o auth muda
  useEffect(() => {
    saveJSON(LS_AUTH, auth);
  }, [auth]);

  // Logout limpa e “derruba” o shell
  function logout() {
    setAuth(null);
    localStorage.removeItem(LS_AUTH);
  }

  // Sem login: tela de login
  if (!auth) {
    return (
      <div className="min-h-screen bg-sky-50 p-3">
        <Login
          onOk={(a, rememberChoice) => {
            // persiste a sessão só se marcar “Permanecer conectado”
            if (rememberChoice) saveJSON(LS_AUTH, a);
            else localStorage.removeItem(LS_AUTH);
            localStorage.setItem(
              LS_REMEMBER,
              rememberChoice ? "true" : "false"
            );
            setAuth(a);
          }}
        />
      </div>
    );
  }

  // Com login: monta o Shell. A key força remontagem quando troca usuário/papel.
  const shellKey = `${auth.userKey}|${auth.isAdmin ? "A" : "U"}`;
  return <Shell key={shellKey} auth={auth} onLogout={logout} />;
}

// Se o seu projeto usa export default:
export default App;

// (Opcional, só se seu index.tsx usa ReactDOM aqui neste arquivo)
// import { createRoot } from "react-dom/client";
// const root = createRoot(document.getElementById("root")!);
// root.render(<App />);
