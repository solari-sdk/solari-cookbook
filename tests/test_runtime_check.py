from tools.runtime_check import MIN_PYTHON, supported


def test_runtime_policy_rejects_older_python() -> None:
    assert MIN_PYTHON == (3, 11)
    assert not supported((3, 10, 99))
    assert supported((3, 11, 0))
    assert supported((3, 12, 0))
