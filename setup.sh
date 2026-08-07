#!/usr/bin/env sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
venv_dir="$project_dir/.venv"
python_command=${PI_DASHBOARD_PYTHON:-python3}

if ! command -v "$python_command" >/dev/null 2>&1; then
  echo "Python interpreter not found: $python_command" >&2
  exit 1
fi

if ! "$python_command" -c 'import sys; raise SystemExit(sys.version_info < (3, 9))'; then
  echo "Pi Dashboard requires Python 3.9 or newer." >&2
  exit 1
fi

if [ ! -x "$venv_dir/bin/python" ]; then
  echo "Creating virtual environment in $venv_dir"
  "$python_command" -m venv "$venv_dir"
fi

if ! "$venv_dir/bin/python" -c 'import sys; raise SystemExit(sys.version_info < (3, 9))'; then
  echo "The existing .venv uses Python older than 3.9; recreate it with a newer Python." >&2
  exit 1
fi

echo "Installing Pi Dashboard packages"
"$venv_dir/bin/python" -m pip install -r "$project_dir/requirements.txt"

echo "Setup complete. Start with: .venv/bin/python app.py"
