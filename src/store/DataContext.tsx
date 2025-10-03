// src/store/DataContext.tsx
import React, { createContext, useContext, useMemo, useState } from "react";

type Role = "admin" | "user";
type User = { email: string; password: string; role: Role };

type State = {
  users: User[];
  auth: { email: string | null; role: Role | null };
};

type Ctx = {
  state: State;
  setState: React.Dispatch<React.SetStateAction<State>>;
  login: (email: string, password: string) => boolean;
  logout: () => void;
};

const DataCtx = createContext<Ctx>({} as any);

export const DataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<State>({
    users: [{ email: "admin@paroquia.com", password: "123456", role: "admin" }],
    auth: { email: null, role: null }
  });

  const api = useMemo<Ctx>(() => ({
    state,
    setState,
    login: (email, password) => {
      const u = state.users.find(x => x.email === email && x.password === password);
      if (u) {
        setState(s => ({ ...s, auth: { email: u.email, role: u.role } }));
        return true;
      }
      return false;
    },
    logout: () => setState(s => ({ ...s, auth: { email: null, role: null } }))
  }), [state]);

  return <DataCtx.Provider value={api}>{children}</DataCtx.Provider>;
};

export const useData = () => useContext(DataCtx);
