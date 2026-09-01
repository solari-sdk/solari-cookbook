from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, HttpUrl

from app.public_enrichment import correlate_alias_observations

router = APIRouter(prefix="/api/v1/recon", tags=["recon"])


class AliasObservationInput(BaseModel):
    alias: str = Field(min_length=2, max_length=80)
    source_url: HttpUrl
    source_name: str | None = Field(default=None, max_length=120)


@router.post("/alias-correlation")
def alias_correlation(observations: list[AliasObservationInput]) -> dict[str, object]:
    if len(observations) > 1000:
        raise HTTPException(400, "alias observation set exceeds 1000 records")
    try:
        candidates = correlate_alias_observations([
            {"alias": item.alias, "source_url": str(item.source_url), "source_name": item.source_name}
            for item in observations
        ])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "candidates": candidates,
        "count": len(candidates),
        "identity_asserted": False,
        "explanation": "Candidates are exact normalized-alias matches across supplied public HTTPS evidence and require analyst review.",
    }
