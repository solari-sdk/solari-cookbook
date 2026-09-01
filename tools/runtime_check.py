from __future__ import print_function

import sys

MIN_PYTHON = (3, 11)


def supported(version_info=None):
    version_info = version_info or sys.version_info
    return tuple(version_info[:2]) >= MIN_PYTHON


def main():
    if supported():
        print("Python runtime supported: {}.{}".format(sys.version_info[0], sys.version_info[1]))
        return 0
    print(
        "ERROR: Python {}.{}+ is required; found {}.{}.".format(
            MIN_PYTHON[0], MIN_PYTHON[1], sys.version_info[0], sys.version_info[1]
        ),
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
