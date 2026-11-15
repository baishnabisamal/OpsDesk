COMPOSE = docker compose --env-file .env -f infra/docker-compose.yml

.PHONY: help setup up down reset ps logs test lint format

help: ## List the available commands
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-8s %s\n", $$1, $$2}'

setup: ## Create .env (if missing) and install dependencies
	@test -f .env || (cp .env.example .env && echo "Created .env - change POSTGRES_PASSWORD")
	npm install

up: ## Start Postgres, Redis and Mailpit, and wait until healthy
	$(COMPOSE) up -d --wait

down: ## Stop the containers (data is kept)
	$(COMPOSE) down

reset: ## Stop the containers and delete the database volume
	$(COMPOSE) down -v

ps: ## Show container status
	$(COMPOSE) ps

logs: ## Follow container logs
	$(COMPOSE) logs -f

test: ## Run the test suite
	npm test

lint: ## ESLint, type check and formatting check
	npm run lint

format: ## Rewrite files with Prettier
	npm run format
