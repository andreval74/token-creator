const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { ethers } = require('ethers');
const solc = require('solc');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Network configurations
const networks = {
    'ethereum': {
        rpc: process.env.ETHEREUM_RPC || 'https://mainnet.infura.io/v3/' + process.env.INFURA_API_KEY,
        chainId: 1,
        explorer: 'https://etherscan.io'
    },
    'ethereum-goerli': {
        rpc: process.env.GOERLI_RPC || 'https://goerli.infura.io/v3/' + process.env.INFURA_API_KEY,
        chainId: 5,
        explorer: 'https://goerli.etherscan.io'
    },
    'bsc': {
        rpc: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org',
        chainId: 56,
        explorer: 'https://bscscan.com'
    },
    'bsc-testnet': {
        rpc: process.env.BSC_TESTNET_RPC || 'https://data-seed-prebsc-1-s1.binance.org:8545',
        chainId: 97,
        explorer: 'https://testnet.bscscan.com'
    },
    'polygon': {
        rpc: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
        chainId: 137,
        explorer: 'https://polygonscan.com'
    },
    'polygon-mumbai': {
        rpc: process.env.MUMBAI_RPC || 'https://rpc-mumbai.maticvigil.com',
        chainId: 80001,
        explorer: 'https://mumbai.polygonscan.com'
    }
};

// CREATE2 Factory Contract (simplified)
const CREATE2_FACTORY_ABI = [
    "function deploy(uint256 amount, bytes32 salt, bytes memory bytecode) external payable returns (address)",
    "function computeAddress(bytes32 salt, bytes32 bytecodeHash) external view returns (address)"
];

// Utility functions
function calculateCREATE2Address(deployerAddress, salt, bytecodeHash) {
    const create2Prefix = '0xff';
    const concatenated = ethers.utils.concat([
        create2Prefix,
        deployerAddress,
        salt,
        bytecodeHash
    ]);
    const hash = ethers.utils.keccak256(concatenated);
    return ethers.utils.getAddress('0x' + hash.slice(-40));
}

async function findSaltForTermination(deployerAddress, bytecodeHash, desiredTermination, maxAttempts = 1000000) {
    const termination = desiredTermination.toLowerCase();
    let attempts = 0;
    
    while (attempts < maxAttempts) {
        const randomBytes = crypto.randomBytes(32);
        const salt = '0x' + randomBytes.toString('hex');
        const address = calculateCREATE2Address(deployerAddress, salt, bytecodeHash);
        
        if (address.toLowerCase().endsWith(termination)) {
            return {
                salt,
                address,
                attempts: attempts + 1
            };
        }
        
        attempts++;
        
        // Yield control every 1000 attempts
        if (attempts % 1000 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    
    throw new Error('Maximum attempts reached without finding suitable salt');
}

// Routes

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Compile Solidity contract
app.post('/compile', async (req, res) => {
    try {
        const { sourceCode, contractName, compilerVersion = '0.8.19' } = req.body;
        
        if (!sourceCode || !contractName) {
            return res.status(400).json({
                success: false,
                error: 'sourceCode and contractName are required'
            });
        }
        
        // Prepare Solidity compiler input
        const input = {
            language: 'Solidity',
            sources: {
                'contract.sol': {
                    content: sourceCode
                }
            },
            settings: {
                outputSelection: {
                    '*': {
                        '*': ['abi', 'evm.bytecode.object', 'evm.gasEstimates']
                    }
                },
                optimizer: {
                    enabled: true,
                    runs: 200
                }
            }
        };
        
        // Compile
        const output = JSON.parse(solc.compile(JSON.stringify(input)));
        
        if (output.errors) {
            const errors = output.errors.filter(error => error.severity === 'error');
            if (errors.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Compilation failed',
                    details: errors
                });
            }
        }
        
        const contract = output.contracts['contract.sol'][contractName];
        
        if (!contract) {
            return res.status(400).json({
                success: false,
                error: `Contract ${contractName} not found`
            });
        }
        
        const bytecode = '0x' + contract.evm.bytecode.object;
        const abi = contract.abi;
        const gasEstimate = contract.evm.gasEstimates?.creation?.totalCost || 'unknown';
        
        res.json({
            success: true,
            bytecode,
            abi,
            gasEstimate,
            warnings: output.errors?.filter(error => error.severity === 'warning') || []
        });
        
    } catch (error) {
        console.error('Compilation error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Calculate CREATE2 address with custom termination
app.post('/calculate-address', async (req, res) => {
    try {
        const { deployerAddress, bytecodeHash, desiredTermination, maxAttempts = 100000 } = req.body;
        
        if (!deployerAddress || !bytecodeHash || !desiredTermination) {
            return res.status(400).json({
                success: false,
                error: 'deployerAddress, bytecodeHash, and desiredTermination are required'
            });
        }
        
        // Validate termination
        const cleanTermination = desiredTermination.toLowerCase().replace(/[^0-9a-f]/g, '');
        if (cleanTermination.length === 0 || cleanTermination.length > 8) {
            return res.status(400).json({
                success: false,
                error: 'Invalid termination. Must be 1-8 hexadecimal characters.'
            });
        }
        
        // Find salt
        const result = await findSaltForTermination(
            deployerAddress,
            bytecodeHash,
            cleanTermination,
            Math.min(maxAttempts, 1000000) // Cap at 1M attempts
        );
        
        res.json({
            success: true,
            ...result,
            termination: cleanTermination
        });
        
    } catch (error) {
        console.error('Address calculation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Deploy contract using CREATE2
app.post('/deploy', async (req, res) => {
    try {
        const { bytecode, salt, constructorParams = [], network = 'bsc-testnet' } = req.body;
        
        if (!bytecode || !salt) {
            return res.status(400).json({
                success: false,
                error: 'bytecode and salt are required'
            });
        }
        
        const networkConfig = networks[network];
        if (!networkConfig) {
            return res.status(400).json({
                success: false,
                error: 'Unsupported network'
            });
        }
        
        // Connect to network
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        
        // Encode constructor parameters if any
        let deployBytecode = bytecode;
        if (constructorParams.length > 0) {
            const abiCoder = new ethers.utils.AbiCoder();
            const encodedParams = abiCoder.encode(
                constructorParams.map(p => p.type),
                constructorParams.map(p => p.value)
            );
            deployBytecode += encodedParams.slice(2); // Remove 0x prefix
        }
        
        // Calculate deployment address
        const bytecodeHash = ethers.utils.keccak256(deployBytecode);
        const deploymentAddress = calculateCREATE2Address(wallet.address, salt, bytecodeHash);
        
        // Deploy using CREATE2 (simplified - in production, use a factory contract)
        const deploymentTx = {
            data: deployBytecode,
            gasLimit: 3000000,
            gasPrice: await provider.getGasPrice()
        };
        
        const tx = await wallet.sendTransaction(deploymentTx);
        const receipt = await tx.wait();
        
        res.json({
            success: true,
            transactionHash: receipt.transactionHash,
            contractAddress: receipt.contractAddress,
            gasUsed: receipt.gasUsed.toString(),
            blockNumber: receipt.blockNumber,
            explorerUrl: `${networkConfig.explorer}/tx/${receipt.transactionHash}`
        });
        
    } catch (error) {
        console.error('Deployment error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get network information
app.get('/networks', (req, res) => {
    const networkList = Object.keys(networks).map(key => ({
        id: key,
        name: key.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase()),
        chainId: networks[key].chainId,
        explorer: networks[key].explorer
    }));
    
    res.json({
        success: true,
        networks: networkList
    });
});

// Validate termination
app.post('/validate-termination', (req, res) => {
    try {
        const { termination } = req.body;
        
        if (!termination) {
            return res.status(400).json({
                success: false,
                error: 'termination is required'
            });
        }
        
        const cleaned = termination.toLowerCase().replace(/[^0-9a-f]/g, '');
        const isValid = /^[0-9a-f]+$/.test(cleaned) && cleaned.length > 0 && cleaned.length <= 8;
        
        let difficulty = 'Unknown';
        let estimatedTime = 'Unknown';
        
        if (isValid) {
            const attempts = Math.pow(16, cleaned.length);
            const attemptsPerSecond = 1000;
            const timeSeconds = attempts / (2 * attemptsPerSecond);
            
            if (attempts < 256) {
                difficulty = 'Very Easy';
                estimatedTime = 'Instant';
            } else if (attempts < 4096) {
                difficulty = 'Easy';
                estimatedTime = 'Few seconds';
            } else if (attempts < 65536) {
                difficulty = 'Medium';
                estimatedTime = 'Few minutes';
            } else if (attempts < 1048576) {
                difficulty = 'Hard';
                estimatedTime = 'Few hours';
            } else {
                difficulty = 'Very Hard';
                estimatedTime = 'Days or weeks';
            }
        }
        
        res.json({
            success: true,
            valid: isValid,
            cleaned,
            difficulty,
            estimatedTime,
            maxLength: 8
        });
        
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Token Creator API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

