# Agent Configuration for Zero Email

Zero is an open-source AI email solution built with a modern TypeScript/Next.js stack in a monorepo setup.

## Project Structure

This is a Bun workspace monorepo with the following structure:
- `apps/mail/` - Next.js frontend email client
- `apps/server/` - Backend server
- `apps/ios-app/` - iOS mobile app
- `packages/cli/` - CLI tools (`nizzy` command)
- `packages/db/` - Database schemas and utilities
- `packages/eslint-config/` - Shared ESLint configuration
- `packages/tsconfig/` - Shared TypeScript configuration

## Frequently Used Commands

### Development
- `bun go` - Quick start: starts database and dev servers
- `bun dev` - Start all development servers (uses Turbo)
- `bun docker:db:up` - Start PostgreSQL database in Docker
- `bun docker:db:down` - Stop and remove database container
- `bun docker:db:clean` - Stop and remove database with volumes

### Build & Deploy
- `bun run build` - Build all packages (uses Turbo)
- `bun run build:frontend` - Build only the mail frontend
- `bun run deploy:frontend` - Deploy frontend
- `bun run deploy:backend` - Deploy backend

### Code Quality
- `bun run check` - Run format check and lint
- `bun run lint` - Run ESLint across all packages
- `bun run format` - Format code with Prettier
- `bun run check:format` - Check code formatting

### Database
- `bun db:push` - Push schema changes to database
- `bun db:generate` - Generate migration files
- `bun db:migrate` - Apply database migrations
- `bun db:studio` - Open Drizzle Studio

### Testing & Evaluation
- `bun run test:ai` - Run AI tests
- `bun run eval` - Run evaluation suite
- `bun run eval:dev` - Run evaluation in dev mode
- `bun run eval:ci` - Run evaluation in CI mode

### Utilities
- `bun nizzy env` - Setup environment variables
- `bun nizzy sync` - Sync environment variables and types
- `bun scripts` - Run custom scripts

## Tech Stack

- **Frontend**: Next.js, React 19, TypeScript, TailwindCSS, Shadcn UI
- **Backend**: Node.js, tRPC, Drizzle ORM
- **Database**: PostgreSQL
- **Authentication**: Better Auth, Google OAuth
- **Package Manager**: Bun (v1.2+)
- **Build Tool**: Turbo
- **Linting**: ESLint, Oxlint, Prettier

## Code Style & Conventions

### Formatting
- 2-space indentation
- Single quotes
- 100 character line width
- Semicolons required
- Uses Prettier with sort-imports and Tailwind plugins

### File Organization
- TypeScript strict mode enabled
- Workspace packages use catalog versioning for shared dependencies
- Monorepo managed with Bun workspaces

### Important Environment Variables
- `BETTER_AUTH_SECRET` - Auth secret key
- `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET` - Gmail integration
- `AUTUMN_SECRET_KEY` - Encryption service
- `TWILIO_*` - SMS integration
- `DATABASE_URL` - PostgreSQL connection string

## Development Setup

1. Install dependencies: `bun install`
2. Setup environment: `bun nizzy env`
3. Sync environment: `bun nizzy sync`
4. Start database: `bun docker:db:up`
5. Initialize database: `bun db:push`
6. Start development: `bun dev`

## Common Workflow

1. Always run `bun run check` before committing
2. Use `bun nizzy sync` after environment variable changes
3. Run `bun db:push` after schema changes
4. Use `bun go` for quick development startup

## Notes

- Uses Husky for git hooks
- Integrates with Sentry for error tracking
- Uses Cloudflare Workers for backend deployment
- iOS app is part of the monorepo
- CLI tool `nizzy` helps manage environment and sync operations

## IMPORTANT RESTRICTIONS

- **NEVER run project-wide lint/format commands** (`bun run check`, `bun run lint`, `bun run format`, `bun run check:format`)
- These commands format/lint the entire codebase and cause unnecessary changes
- Only use targeted linting/formatting on specific files when absolutely necessary
- Focus on the specific task at hand without touching unrelated files
