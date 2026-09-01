from fastapi import APIRouter

from app.domain_contract import build_domain_contract

router = APIRouter(prefix="/api/v1", tags=["contracts"])


@router.get("/domain-contract")
def domain_contract() -> dict[str, object]:
    """Publish the same compatibility manifest checked into the static console."""
    return build_domain_contract()
