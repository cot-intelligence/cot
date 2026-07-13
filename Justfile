default:
    @just --list

check:
    ruff check backend
    python3 -m pytest -q backend/tests

status:
    #!/usr/bin/env sh
    set -eu

    endpoint="${COT_ENDPOINT:-http://127.0.0.1:31337}"
    bridge="${COT_BRIDGE:-${HOME}/.cot/bin/cot}"

    printf '%s\n' "Collector: ${endpoint}"
    if curl -fsS "${endpoint}/health" >/dev/null 2>&1; then
      curl -fsS "${endpoint}/health"
      printf '\n'
    else
      printf '%s\n' "collector health check failed"
    fi

    printf '\n%s\n' "Compose:"
    docker compose ps || true

    printf '\n%s\n' "Bridge:"
    if [ -x "${bridge}" ]; then
      "${bridge}" status
    else
      printf '%s\n' "bridge not installed at ${bridge}"
    fi

logs target="dev":
    #!/usr/bin/env sh
    set -eu

    case "{{target}}" in
      dev|compose)
        docker compose logs -f
        ;;
      api|web)
        docker compose logs -f "{{target}}"
        ;;
      prod|docker)
        just docker-logs
        ;;
      *)
        printf '%s\n' "usage: just logs [dev|compose|api|web|prod|docker]" >&2
        exit 2
        ;;
    esac

docker-logs:
    #!/usr/bin/env sh
    set -eu

    container="${COT_CONTAINER:-cot}"
    docker logs -f "${container}"

dev action:
    #!/usr/bin/env sh
    set -eu

    endpoint="${COT_ENDPOINT:-http://127.0.0.1:31337}"
    agents="${COT_AGENTS:-claude cursor codex}"

    wait_for_health() {
      i=0
      until curl -fsS "${endpoint}/health" >/dev/null 2>&1; do
        i=$((i + 1))
        if [ "${i}" -gt 60 ]; then
          printf '%s\n' "cot dev collector did not become healthy at ${endpoint}" >&2
          printf '%s\n' "Recent API logs:" >&2
          docker compose logs --tail=80 api >&2 || true
          exit 1
        fi
        sleep 1
      done
    }

    case "{{action}}" in
      up)
        env COT_DOCKER_UID="$(id -u)" COT_DOCKER_GID="$(id -g)" docker compose up --build -d
        wait_for_health
        env COT_ENDPOINT="${endpoint}" COT_AGENTS="${agents}" just bridge install
        printf '%s\n' "cot dev is up at ${endpoint}"
        ;;
      down)
        docker compose down
        ;;
      status)
        env COT_ENDPOINT="${endpoint}" just status
        ;;
      logs)
        just logs dev
        ;;
      *)
        printf '%s\n' "usage: just dev <up|down|status|logs>" >&2
        exit 2
        ;;
    esac

bridge action:
    #!/usr/bin/env sh
    set -eu

    endpoint="${COT_ENDPOINT:-http://127.0.0.1:31337}"
    agents="${COT_AGENTS:-claude cursor codex}"
    bridge="${COT_BRIDGE:-${HOME}/.cot/bin/cot}"
    agent_query=$(printf '%s' "${agents}" | tr ' ' ',')

    case "{{action}}" in
      install)
        script=$(mktemp)
        trap 'rm -f "${script}"' EXIT
        curl -fsSL "${endpoint}/install.sh" -o "${script}"
        env COT_ENDPOINT="${endpoint}" COT_AGENTS="${agents}" sh "${script}"
        ;;
      repair)
        script=$(mktemp)
        trap 'rm -f "${script}"' EXIT
        curl -fsSL "${endpoint}/repair.sh?agents=${agent_query}" -o "${script}"
        env COT_ENDPOINT="${endpoint}" COT_AGENTS="${agents}" sh "${script}"
        ;;
      status)
        if [ -x "${bridge}" ]; then
          "${bridge}" status
        else
          printf '%s\n' "bridge not installed at ${bridge}" >&2
          exit 1
        fi
        ;;
      path)
        printf '%s\n' "${bridge}"
        ;;
      *)
        printf '%s\n' "usage: just bridge <install|repair|status|path>" >&2
        exit 2
        ;;
    esac

prod action:
    #!/usr/bin/env sh
    set -eu

    container="${COT_CONTAINER:-cot}"
    agents="${COT_AGENTS:-claude cursor codex}"
    bridge="${COT_BRIDGE:-${HOME}/.cot/bin/cot}"

    case "{{action}}" in
      up)
        script=$(mktemp)
        trap 'rm -f "${script}"' EXIT
        curl -fsSL https://cot.run/install -o "${script}"
        env COT_AGENTS="${agents}" sh "${script}"
        ;;
      down)
        if docker stop "${container}" >/dev/null 2>&1; then
          printf '%s\n' "cot prod container stopped: ${container}"
        else
          printf '%s\n' "No running cot prod container named ${container}."
        fi
        ;;
      status)
        docker ps --filter "name=^/${container}$" || true
        if [ -x "${bridge}" ]; then
          "${bridge}" status
        else
          printf '%s\n' "bridge not installed at ${bridge}"
        fi
        ;;
      logs)
        just docker-logs
        ;;
      *)
        printf '%s\n' "usage: just prod <up|down|status|logs>" >&2
        exit 2
        ;;
    esac
