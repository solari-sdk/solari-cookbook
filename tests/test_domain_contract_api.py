from fastapi.testclient import TestClient

from app.domain_contract import build_domain_contract
from app.main import app


client = TestClient(app)


def test_domain_contract_endpoint_matches_generated_server_contract():
    response = client.get("/api/v1/domain-contract")
    assert response.status_code == 200
    assert response.json() == build_domain_contract()
