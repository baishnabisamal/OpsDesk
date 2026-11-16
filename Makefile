COMPOSE = docker compose --env-file .env -f infra/docker-compose.yml

ML_PYTHON = ml/.venv/bin/python

.PHONY: help setup up down reset ps logs migrate seed dev test lint format ml-setup ml-data ml-train ml-dev ml-test

help: ## List the available commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-9s %s\n", $$1, $$2}'

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

migrate: ## Apply new SQL migrations (as the owner role)
	npm run migrate

seed: ## Load the demo data (same data every time)
	npm run seed

dev: ## Start the API and restart it when files change
	npm run dev

test: ## Run the test suite
	npm test

ml-setup: ## Create the Python virtual environment for the ML service
	python3 -m venv ml/.venv
	$(ML_PYTHON) -m pip install -r ml/requirements.txt

ml-data: ## Rebuild the synthetic training data (ml/data/tickets.csv)
	cd ml && .venv/bin/python generate_data.py

ml-train: ## Train the intent model and print macro-F1
	cd ml && .venv/bin/python train.py

ml-dev: ## Start the ML service on port 8001 (reads the secret from .env)
	cd ml && set -a && . ../.env && set +a && .venv/bin/python -m uvicorn service:app --port 8001

ml-test: ## Run the ML service tests
	cd ml && .venv/bin/python -m pytest -q

lint: ## ESLint, type check and formatting check
	npm run lint

format: ## Rewrite files with Prettier
	npm run format
