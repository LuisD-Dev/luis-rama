# Teclia Academia

Teclia Academia is a small learning platform combining a React + Vite frontend with an Express backend for authentication, content management and basic usage statistics.

This repository contains the full-stack code (frontend in the repository root and backend under `Backend/`). The backend supports either local SQLite (default) or PostgreSQL/Supabase..

**Quick links**

- Developer setup: [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md)
- Full API reference: [API_DOCUMENTATION.md](API_DOCUMENTATION.md)

## Features

- Email/password authentication (JWT):
- User profiles with avatar uploads (Supabase storage or local uploads)
- Content upload and access control by plan tier (free/basico/premium)
- Basic site statistics tracking

## Tech stack

- Frontend: React (18), Vite, Axios
- Backend: Node.js (ESM), Express, JWT-based auth, multer, Supabase storage client
- Database: SQLite by default, optional PostgreSQL (via `DATABASE_URL`)

## Getting started (short)

1. Read the full developer setup: [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md)
2. Start the backend (from `Backend/`):

```bash
cd Backend
npm install
npm run dev
```

3. Start the frontend (project root):

```bash
npm install
npm run dev
```

4. Visit the frontend (Vite) URL (typically `http://localhost:5173`) and ensure backend API is reachable at `http://localhost:3001`.

## Where to read more

- Developer setup and environment variables: [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md)
- API reference and examples: [API_DOCUMENTATION.md](API_DOCUMENTATION.md)

## Contributing

If you'd like to contribute:

1. Fork the repository and create a branch for your work.
2. Open a pull request describing the change and relevant motivation or screenshots.
3. Keep changes focused and add tests where applicable.

If you plan to modify backend behavior that affects the API, update [API_DOCUMENTATION.md](API_DOCUMENTATION.md) accordingly.

## License

This repository does not include a finalized license. Add a `LICENSE` file with the desired license (e.g., MIT) before publishing.

---
_If anything in this README is unclear, open an issue or ask for clarification in a PR._
