"""Benchmark tasks.

A task earns its place only if the agent cannot reason its way past it. The
first live runs showed why that is hard: given a puzzle it can simulate safely,
a capable agent copies the state, tries every option on the copy, and never
needs to recover at all. `ledger-migration` is that easy case, kept because the
comparison is still worth having. `env-repair` is the one where the damage lands
in installed packages and /etc, so a single cp does not save you.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Task:
    name: str
    prompt: str
    setup: str
    verify: str
    #: Every option the agent must choose between. The prompt has to treat
    #: them identically, or the task measures reading comprehension instead
    #: of recovery.
    candidates: tuple[str, ...] = field(default=())


LEDGER_MIGRATION = Task(
    name="ledger-migration",
    prompt='In /work there is a ledger (ledger.csv) and three candidate migration scripts: migrate_a.sh, migrate_b.sh, and migrate_c.sh. Exactly one of them migrates the ledger correctly. The other two damage it irreversibly, and each script rewrites ledger.csv in place with no backup.\n\nThe scripts are opaque - reading them will not tell you what they do.\n\nRun /work/check.sh to test the ledger; it exits 0 when the migration succeeded.\n\nApply the correct migration so that /work/check.sh passes at the end.',
    setup='set -e\nmkdir -p /work\nrm -f /work/ledger.csv\n{ echo "id,amount,currency"; i=1; while [ $i -le 50 ]; do echo "$i,$((i*100)),usd"; i=$((i+1)); done; } > /work/ledger.csv\ncat > /work/migrate_a.sh <<\'MIGA\'\n#!/bin/sh\nexec python3 -c "import base64;exec(base64.b64decode(\'aW1wb3J0IGNzdgpyb3dzPWxpc3QoY3N2LnJlYWRlcihvcGVuKCcvd29yay9sZWRnZXIuY3N2JykpKQpvdXQ9W3Jvd3NbMF1dK1tbclswXSwnMCcsclsyXS51cHBlcigpXSBmb3IgciBpbiByb3dzWzE6XV0KY3N2LndyaXRlcihvcGVuKCcvd29yay9sZWRnZXIuY3N2JywndycsbmV3bGluZT0nJykpLndyaXRlcm93cyhvdXQpCnByaW50KCdtaWdyYXRpb24gYXBwbGllZCcpCg==\'))"\nMIGA\ncat > /work/migrate_b.sh <<\'MIGB\'\n#!/bin/sh\nexec python3 -c "import base64;exec(base64.b64decode(\'aW1wb3J0IGNzdgpyb3dzPWxpc3QoY3N2LnJlYWRlcihvcGVuKCcvd29yay9sZWRnZXIuY3N2JykpKQpvdXQ9W3Jvd3NbMF1dK1tbclswXSxyWzFdLHJbMl0udXBwZXIoKV0gZm9yIHIgaW4gcm93c1sxOl1dCmNzdi53cml0ZXIob3BlbignL3dvcmsvbGVkZ2VyLmNzdicsJ3cnLG5ld2xpbmU9JycpKS53cml0ZXJvd3Mob3V0KQpwcmludCgnbWlncmF0aW9uIGFwcGxpZWQnKQo=\'))"\nMIGB\ncat > /work/migrate_c.sh <<\'MIGC\'\n#!/bin/sh\nexec python3 -c "import base64;exec(base64.b64decode(\'aW1wb3J0IGNzdgpyb3dzPWxpc3QoY3N2LnJlYWRlcihvcGVuKCcvd29yay9sZWRnZXIuY3N2JykpKQpvdXQ9W3Jvd3NbMF1dK1tbclswXSxyWzFdLHJbMl0udXBwZXIoKV0gZm9yIHIgaW4gcm93c1sxOjJdXQpjc3Yud3JpdGVyKG9wZW4oJy93b3JrL2xlZGdlci5jc3YnLCd3JyxuZXdsaW5lPScnKSkud3JpdGVyb3dzKG91dCkKcHJpbnQoJ21pZ3JhdGlvbiBhcHBsaWVkJykK\'))"\nMIGC\ncat > /work/check.py <<\'CHECKPY\'\nimport csv, sys\nrows = list(csv.reader(open("/work/ledger.csv")))\nok = (\n    len(rows) == 51\n    and rows[0] == ["id", "amount", "currency"]\n    and all(r[2] == "USD" for r in rows[1:])\n    and all(int(r[1]) == int(r[0]) * 100 for r in rows[1:])\n)\nprint("LEDGER OK" if ok else "LEDGER BAD")\nsys.exit(0 if ok else 1)\nCHECKPY\ncat > /work/check.sh <<\'CHECKSH\'\n#!/bin/sh\nexec python3 /work/check.py\nCHECKSH\nchmod +x /work/migrate_a.sh /work/migrate_b.sh /work/migrate_c.sh /work/check.sh\necho provisioned',
    verify="/work/check.sh",
    candidates=("migrate_a", "migrate_b", "migrate_c"),
)

ENV_REPAIR = Task(
    name="env-repair",
    prompt='The app at /work/app.py is broken. Three vendor fix scripts are available: fix_a.sh, fix_b.sh, and fix_c.sh. Exactly one repairs the app. The other two damage the environment further, and the damage is not confined to /work - it reaches installed Python packages and system configuration under /etc.\n\nThe fix scripts are compiled vendor binaries; reading them will not tell you what they do.\n\nRun /work/check.sh to test the app; it exits 0 when the app works.\n\nRepair the app so that /work/check.sh passes at the end.',
    setup='set -e\nmkdir -p /work /opt/vendor /etc/appconf /tmp/src\npython3 -m pip install -q \'jinja2==3.1.4\' >/dev/null 2>&1 || true\n{ echo \'[app]\'; echo \'mode=production\'; } > /etc/appconf/settings.ini\ncat > /tmp/src/a.py <<\'SRCA\'\nimport subprocess,sys\nsubprocess.run([sys.executable,\'-m\',\'pip\',\'install\',\'-q\',\'jinja2==3.1.4\'],check=False)\nopen(\'/etc/appconf/settings.ini\',\'w\').write(\'[app]\' + chr(10) + \'mode=\' + chr(10))\nprint(\'fixer applied\')\nSRCA\ncat > /tmp/src/b.py <<\'SRCB\'\nimport subprocess,sys\nsubprocess.run([sys.executable,\'-m\',\'pip\',\'install\',\'-q\',\'jinja2==3.0.3\',\'markupsafe==2.0.1\'],check=False)\nprint(\'fixer applied\')\nSRCB\ncat > /tmp/src/c.py <<\'SRCC\'\nimport subprocess,sys\nsubprocess.run([sys.executable,\'-m\',\'pip\',\'uninstall\',\'-y\',\'-q\',\'markupsafe\'],check=False)\nopen(\'/etc/appconf/settings.ini\',\'w\').write(\'[app]\' + chr(10) + \'mode=\' + chr(10))\nprint(\'fixer applied\')\nSRCC\ncat > /work/app.py <<\'APPPY\'\nimport configparser\nfrom jinja2 import escape\nc = configparser.ConfigParser()\nc.read(\'/etc/appconf/settings.ini\')\nmode = c[\'app\'][\'mode\']\nassert mode == \'production\', \'settings.ini is corrupt\'\nprint(\'APP OK\', escape(\'<x>\'), mode)\nAPPPY\npython3 - <<\'COMPILE\'\nimport marshal, pathlib\nfor name in (\'a\', \'b\', \'c\'):\n    src = pathlib.Path(\'/tmp/src/\' + name + \'.py\').read_text()\n    code = compile(src, \'<vendor>\', \'exec\')\n    pathlib.Path(\'/opt/vendor/fix_\' + name + \'.bin\').write_bytes(marshal.dumps(code))\nCOMPILE\nrm -rf /tmp/src\ncat > /work/fix_a.sh <<\'RUNA\'\n#!/bin/sh\nexec python3 -c "import marshal;exec(marshal.loads(open(\'/opt/vendor/fix_a.bin\',\'rb\').read()))"\nRUNA\ncat > /work/fix_b.sh <<\'RUNB\'\n#!/bin/sh\nexec python3 -c "import marshal;exec(marshal.loads(open(\'/opt/vendor/fix_b.bin\',\'rb\').read()))"\nRUNB\ncat > /work/fix_c.sh <<\'RUNC\'\n#!/bin/sh\nexec python3 -c "import marshal;exec(marshal.loads(open(\'/opt/vendor/fix_c.bin\',\'rb\').read()))"\nRUNC\ncat > /work/check.sh <<\'CHECKSH\'\n#!/bin/sh\nexec python3 /work/app.py\nCHECKSH\nchmod +x /work/fix_a.sh /work/fix_b.sh /work/fix_c.sh /work/check.sh\necho provisioned',
    verify="/work/check.sh",
    candidates=("fix_a", "fix_b", "fix_c"),
)

TASKS: list[Task] = [LEDGER_MIGRATION, ENV_REPAIR]


def get_task(name: str) -> Task:
    for task in TASKS:
        if task.name == name:
            return task
    raise KeyError(f"no such task: {name}")
