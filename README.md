# TC / Test Case Tool

QA alat za test slucajeve: koraci sa screenshotovima (Ctrl+V), statusi sa
autorom i vremenom, tabelarni (Excel-like) prikaz, filter po environmentu.

## Pokretanje lokalno (korak 1)

Preduslov: Node.js 18+ (proveri sa `node -v`)

    npm install
    npm run dev

Otvori http://localhost:5173

U ovoj fazi podaci se cuvaju u localStorage (samo tvoj browser).
Supabase (baza + login + slike) dolazi u sledecim koracima -
menja se samo `src/storageShim.js`, komponenta ostaje ista.

## Sledeci koraci

2. Supabase projekat + sema baze
3. Slike u Supabase Storage
4. Login (Supabase Auth) + Row Level Security
5. Deploy na Vercel

## Struktura

    src/QATestCaseTool.jsx  - cela aplikacija (UI + logika)
    src/storageShim.js      - sloj za podatke (ovde ide Supabase kasnije)
    src/main.jsx            - entry point
