# Mzazi Care - Supervisor/Admin Web App

React + Vite + TypeScript. See the repo root `README.md`'s "Local development" section for how to
run this alongside `backend/`.

Scaffolded from Vite's `react-ts` template (HEZ-52); ESLint + Prettier replace the template's
default Oxlint setup to match `backend/`'s tooling. See `docs/project-state.md` for the framework
and library decisions behind this app (`react-router-dom`, TanStack Query,
`amazon-cognito-identity-js`).

```bash
npm install
cp .env.example .env   # points at the local backend + the real deployed Cognito User Pool
npm run dev
```
