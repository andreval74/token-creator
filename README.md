# Token Creator Pro API

API para compilação de contratos Solidity e deploy com CREATE2.

## Endpoints

### POST /compile
Compila um contrato Solidity e retorna o bytecode.

**Request:**
```json
{
  "sourceCode": "contract source code",
  "contractName": "TokenName",
  "compilerVersion": "0.8.19"
}
```

**Response:**
```json
{
  "success": true,
  "bytecode": "0x608060405...",
  "abi": [...],
  "gasEstimate": 2100000
}
```

### POST /calculate-address
Calcula endereço CREATE2 para uma terminação específica.

**Request:**
```json
{
  "deployerAddress": "0x...",
  "bytecodeHash": "0x...",
  "desiredTermination": "cafe",
  "maxAttempts": 100000
}
```

**Response:**
```json
{
  "success": true,
  "salt": "0x...",
  "address": "0x...cafe",
  "attempts": 12345
}
```

### POST /deploy
Faz deploy do contrato usando CREATE2.

**Request:**
```json
{
  "bytecode": "0x608060405...",
  "salt": "0x...",
  "constructorParams": [],
  "network": "bsc-testnet"
}
```

**Response:**
```json
{
  "success": true,
  "transactionHash": "0x...",
  "contractAddress": "0x...",
  "gasUsed": 2100000
}
```

## Deploy no Render

1. Faça fork deste repositório
2. Conecte ao Render
3. Configure as variáveis de ambiente:
   - `INFURA_API_KEY`
   - `PRIVATE_KEY` (para deploy)
   - `BSC_RPC_URL`
4. Deploy automático

## Uso Local

```bash
npm install
npm start
```

A API estará disponível em `http://localhost:3000`

