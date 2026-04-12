const axios = require('axios');
const xml2js = require('xml2js');
require('dotenv').config();

// Configuration
const NC_API_USER = process.env.NC_API_USER;
const NC_API_KEY = process.env.NC_API_KEY;
const NC_USERNAME = process.env.NC_USERNAME;
const NC_CLIENT_IP = process.env.NC_CLIENT_IP;
// Use Production URL by default as requested for "buying"
const BASE_URL = 'https://api.namecheap.com/xml.response'; 

// Helper: Parse XML Response
const parseResponse = async (xmlData) => {
    const parser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });
    try {
        const result = await parser.parseStringPromise(xmlData);
        return result.ApiResponse;
    } catch (err) {
        throw new Error('Failed to parse Namecheap response');
    }
};

// 1. Check Domain Availability
const checkDomain = async (domainName) => {
    try {
        const params = {
            ApiUser: NC_API_USER,
            ApiKey: NC_API_KEY,
            UserName: NC_USERNAME,
            ClientIp: NC_CLIENT_IP,
            Command: 'namecheap.domains.check',
            DomainList: domainName
        };

        const response = await axios.get(BASE_URL, { params });
        const data = await parseResponse(response.data);

        if (data.Status === 'ERROR') {
            const errorMsg = data.Errors && data.Errors.Error ? data.Errors.Error : 'Unknown Error';
            return { success: false, message: errorMsg };
        }

        const checkResult = data.CommandResponse.DomainCheckResult;
        const isAvailable = checkResult.Available === 'true';

        // Get Pricing for the domain
        let price = 'N/A';
        if (isAvailable) {
            const tld = domainName.split('.').pop();
            const pricingParams = {
                ApiUser: NC_API_USER,
                ApiKey: NC_API_KEY,
                UserName: NC_USERNAME,
                ClientIp: NC_CLIENT_IP,
                Command: 'namecheap.users.getPricing',
                ProductType: 'DOMAIN',
                ProductName: tld
            };
            
            const pricingResponse = await axios.get(BASE_URL, { params: pricingParams });
            const pricingData = await parseResponse(pricingResponse.data);

            if (pricingData.Status !== 'ERROR' && pricingData.CommandResponse && pricingData.CommandResponse.UserGetPricingResult) {
                const result = pricingData.CommandResponse.UserGetPricingResult;
                try {
                    // 1. Get ProductType (usually DOMAIN)
                    const pType = result.ProductType;
                    
                    // 2. Get ProductCategories (register, renew, etc.)
                    const categories = Array.isArray(pType.ProductCategory) ? pType.ProductCategory : [pType.ProductCategory];
                    
                    // 3. Find the 'register' category
                    const regCategory = categories.find(c => c.Name === 'register') || categories[0];
                    
                    if (regCategory && regCategory.Product) {
                        const products = Array.isArray(regCategory.Product) ? regCategory.Product : [regCategory.Product];
                        
                        // 4. Find the product for our TLD
                        const matchingProduct = products.find(p => p.Name === tld) || products[0];
                        
                        if (matchingProduct && matchingProduct.Price) {
                            const prices = Array.isArray(matchingProduct.Price) ? matchingProduct.Price : [matchingProduct.Price];
                            // 5. Find the 1-year duration
                            const p1 = prices.find(p => p.Duration === '1') || prices[0];
                            price = `$${p1.YourPrice || p1.Price}`;
                        }
                    }
                } catch (e) {
                    console.error('Pricing Parse Error Details:', e.message);
                }
            }
        }

        return {
            success: true,
            domain: checkResult.Domain,
            available: isAvailable,
            premium: checkResult.IsPremiumName === 'true',
            price: price
        };

    } catch (error) {
        console.error('Namecheap Check Error:', error.message);
        return { success: false, message: error.message };
    }
};

// 2. Register Domain
const registerDomain = async (domainName) => {
    try {
        // Construct contact info from .env
        const contactInfo = {
            FirstName: process.env.NC_FIRST_NAME,
            LastName: process.env.NC_LAST_NAME,
            Address1: process.env.NC_ADDR,
            City: process.env.NC_CITY,
            StateProvince: process.env.NC_STATE,
            PostalCode: process.env.NC_ZIP,
            Country: process.env.NC_COUNTRY,
            Phone: process.env.NC_PHONE,
            EmailAddress: process.env.NC_EMAIL,
            OrganizationName: process.env.NC_FIRST_NAME + ' ' + process.env.NC_LAST_NAME // Fallback org
        };

        // Namecheap requires repeated fields for Registrant, Tech, Admin, AuxBilling
        // We'll map them all to the same user info for simplicity
        const prefixes = ['Registrant', 'Tech', 'Admin', 'AuxBilling'];
        const apiParams = {
            ApiUser: NC_API_USER,
            ApiKey: NC_API_KEY,
            UserName: NC_USERNAME,
            ClientIp: NC_CLIENT_IP,
            Command: 'namecheap.domains.create',
            DomainName: domainName,
            Years: 1 // Default to 1 year
        };

        prefixes.forEach(prefix => {
            apiParams[`${prefix}FirstName`] = contactInfo.FirstName;
            apiParams[`${prefix}LastName`] = contactInfo.LastName;
            apiParams[`${prefix}Address1`] = contactInfo.Address1;
            apiParams[`${prefix}City`] = contactInfo.City;
            apiParams[`${prefix}StateProvince`] = contactInfo.StateProvince;
            apiParams[`${prefix}PostalCode`] = contactInfo.PostalCode;
            apiParams[`${prefix}Country`] = contactInfo.Country;
            apiParams[`${prefix}Phone`] = contactInfo.Phone;
            apiParams[`${prefix}EmailAddress`] = contactInfo.EmailAddress;
            // Optional but often needed
            apiParams[`${prefix}OrganizationName`] = contactInfo.OrganizationName; 
        });

        // Convert params to URLSearchParams to handle special characters properly if needed, 
        // but axios params usually handle this. However, Namecheap POST is recommended for Create.
        // We'll use POST form data.
        const formData = new URLSearchParams(apiParams);

        const response = await axios.post(BASE_URL, formData.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const data = await parseResponse(response.data);

        if (data.Status === 'ERROR') {
            const errorMsg = data.Errors && data.Errors.Error ? JSON.stringify(data.Errors.Error) : 'Unknown Error';
            return { success: false, message: errorMsg };
        }

        const createResult = data.CommandResponse.DomainCreateResult;
        return {
            success: true,
            domain: createResult.Domain,
            registered: createResult.Registered === 'true',
            transactionId: createResult.TransactionID,
            chargedAmount: createResult.ChargedAmount
        };

    } catch (error) {
        console.error('Namecheap Register Error:', error.message);
        return { success: false, message: error.message };
    }
};

// 3. Get Account Balances
const getBalances = async () => {
    try {
        const params = {
            ApiUser: NC_API_USER,
            ApiKey: NC_API_KEY,
            UserName: NC_USERNAME,
            ClientIp: NC_CLIENT_IP,
            Command: 'namecheap.users.getBalances'
        };

        const response = await axios.get(BASE_URL, { params });
        const data = await parseResponse(response.data);

        if (data.Status === 'ERROR') {
            const errorMsg = data.Errors && data.Errors.Error ? data.Errors.Error : 'Unknown Error';
            return { success: false, message: errorMsg };
        }

        const balanceResult = data.CommandResponse.UserGetBalancesResult;
        return {
            success: true,
            availableBalance: balanceResult.AvailableBalance,
            accountBalance: balanceResult.AccountBalance,
            currency: balanceResult.Currency
        };

    } catch (error) {
        console.error('Namecheap Balance Error:', error.message);
        return { success: false, message: error.message };
    }
};

// 4. Get All TLDs from Namecheap
const getTldList = async () => {
    try {
        const params = {
            ApiUser: NC_API_USER,
            ApiKey: NC_API_KEY,
            UserName: NC_USERNAME,
            ClientIp: NC_CLIENT_IP,
            Command: 'namecheap.domains.getTldList'
        };

        const response = await axios.get(BASE_URL, { params });
        const data = await parseResponse(response.data);

        if (data.Status === 'ERROR' || !data.CommandResponse || !data.CommandResponse.TldListResult) {
            console.warn('Get TLD List: API returned no TLDs or Error.');
            return [];
        }

        let tlds = data.CommandResponse.TldListResult.Tld;
        
        if (!tlds) {
            return [];
        }

        if (!Array.isArray(tlds)) {
            tlds = [tlds];
        }

        // Map to just the names (e.g., 'com', 'net')
        return tlds.map(t => t.Name);
    } catch (error) {
        console.error('Get TLD List Error:', error.message);
        return [];
    }
};

// 5. Bulk Check Domains with TLDs
const checkBulkDomains = async (keyword) => {
    try {
        // Fetch dynamic TLD list from Namecheap
        let tlds = await getTldList();
        
        // If API fails, fallback to common ones to ensure functionality
        if (tlds.length === 0) {
            tlds = ['com', 'net', 'org', 'xyz', 'space', 'online', 'site', 'shop', 'icu', 'pw', 'info', 'biz', 'us', 'club', 'top'];
        }

        // Limit to first 50 TLDs (Namecheap max for domains.check is 50-100, we'll use 50 to be safe)
        const tldSubset = tlds.slice(0, 50);
        const domainList = tldSubset.map(tld => `${keyword}.${tld}`).join(',');

        const params = {
            ApiUser: NC_API_USER,
            ApiKey: NC_API_KEY,
            UserName: NC_USERNAME,
            ClientIp: NC_CLIENT_IP,
            Command: 'namecheap.domains.check',
            DomainList: domainList
        };

        const response = await axios.get(BASE_URL, { params });
        const data = await parseResponse(response.data);

        if (data.Status === 'ERROR') {
            const errorMsg = data.Errors && data.Errors.Error ? data.Errors.Error : 'Unknown Error';
            return { success: false, message: errorMsg };
        }

        let checkResults = data.CommandResponse.DomainCheckResult;
        if (!Array.isArray(checkResults)) {
            checkResults = [checkResults];
        }

        const availableDomains = checkResults.filter(r => r.Available === 'true');
        
        const results = [];
        const limit = 30; // Increased to 30 as requested
        
        // Process sequentially to find up to 30 domains under $10
        for (const domain of availableDomains) {
            if (results.length >= limit) break;

            const domainName = domain.Domain;
            const tld = domainName.split('.').pop();
            
            const pricingParams = {
                ApiUser: NC_API_USER,
                ApiKey: NC_API_KEY,
                UserName: NC_USERNAME,
                ClientIp: NC_CLIENT_IP,
                Command: 'namecheap.users.getPricing',
                ProductType: 'DOMAIN',
                ProductName: tld
            };

            try {
                const pricingResponse = await axios.get(BASE_URL, { params: pricingParams });
                const pricingData = await parseResponse(pricingResponse.data);
                let price = 'N/A';

                if (pricingData.Status !== 'ERROR' && pricingData.CommandResponse && pricingData.CommandResponse.UserGetPricingResult) {
                    const pResult = pricingData.CommandResponse.UserGetPricingResult;
                    const pType = pResult.ProductType;
                    const categories = Array.isArray(pType.ProductCategory) ? pType.ProductCategory : [pType.ProductCategory];
                    const regCategory = categories.find(c => c.Name === 'register') || categories[0];
                    
                    if (regCategory && regCategory.Product) {
                        const products = Array.isArray(regCategory.Product) ? regCategory.Product : [regCategory.Product];
                        const matchingProduct = products.find(p => p.Name === tld) || products[0];
                        if (matchingProduct && matchingProduct.Price) {
                            const prices = Array.isArray(matchingProduct.Price) ? matchingProduct.Price : [matchingProduct.Price];
                            const p1 = prices.find(p => p.Duration === '1') || prices[0];
                            price = `${p1.YourPrice || p1.Price}`;
                        }
                    }
                }

                const priceNum = parseFloat(price);
                if (!isNaN(priceNum) && priceNum <= 10.00) {
                    results.push({
                        domain: domainName,
                        price: `$${price}`,
                        available: true
                    });
                }
            } catch (e) {
                console.error(`Error fetching price for ${domainName}:`, e.message);
            }
        }

        return { success: true, domains: results };

    } catch (error) {
        console.error('Bulk Check Error:', error.message);
        return { success: false, message: error.message };
    }
};

// 6. Get Owned Domains
const getOwnedDomains = async (page = 1, pageSize = 20, searchTerm = '') => {
    try {
        const params = {
            ApiUser: NC_API_USER,
            ApiKey: NC_API_KEY,
            UserName: NC_USERNAME,
            ClientIp: NC_CLIENT_IP,
            Command: 'namecheap.domains.getList',
            Page: page,
            PageSize: pageSize,
            SortBy: 'NAME'
        };

        if (searchTerm) {
            params.SearchTerm = searchTerm;
        }

        const response = await axios.get(BASE_URL, { params });
        const data = await parseResponse(response.data);

        if (data.Status === 'ERROR') {
            const errorMsg = data.Errors && data.Errors.Error ? data.Errors.Error : 'Unknown Error';
            return { success: false, message: errorMsg };
        }

        const result = data.CommandResponse.DomainGetListResult;
        let domains = [];
        
        if (result && result.Domain) {
            domains = Array.isArray(result.Domain) ? result.Domain : [result.Domain];
            // Normalize data structure
            domains = domains.map(d => ({
                name: d.Name,
                id: d.ID,
                user: d.User,
                created: d.Created,
                expires: d.Expires,
                isExpired: d.IsExpired === 'true',
                isLocked: d.IsLocked === 'true',
                autoRenew: d.AutoRenew === 'true',
                whoisGuard: d.WhoisGuard // Store raw value (e.g., 'ENABLED', 'AlertBlocked', 'DISABLED')
            }));
        }

        return { 
            success: true, 
            domains: domains,
            paging: result.Paging
        };

    } catch (error) {
        console.error('Get Owned Domains Error:', error.message);
        return { success: false, message: error.message };
    }
};

// 7. Set Custom Nameservers (DNS)
const setNameservers = async (domain, nameservers) => {
    try {
        const parts = domain.split('.');
        const sld = parts[0];
        const tld = parts.slice(1).join('.');
        
        // Nameservers should be comma-separated string for the API
        const nsList = Array.isArray(nameservers) ? nameservers.join(',') : nameservers;

        const params = {
            ApiUser: NC_API_USER,
            ApiKey: NC_API_KEY,
            UserName: NC_USERNAME,
            ClientIp: NC_CLIENT_IP,
            Command: 'namecheap.domains.dns.setCustom',
            SLD: sld,
            TLD: tld,
            Nameservers: nsList
        };

        const response = await axios.get(BASE_URL, { params });
        const data = await parseResponse(response.data);

        if (data.Status === 'ERROR') {
            const errorMsg = data.Errors && data.Errors.Error ? data.Errors.Error : 'Unknown Error';
            return { success: false, message: errorMsg };
        }

        const result = data.CommandResponse.DomainDNSSetCustomResult;
        return {
            success: true,
            domain: result.Domain,
            updated: result.Updated === 'true'
        };

    } catch (error) {
        console.error('Set DNS Error:', error.message);
        return { success: false, message: error.message };
    }
};

module.exports = {
    checkDomain,
    registerDomain,
    getBalances,
    checkBulkDomains,
    getTldList,
    getOwnedDomains,
    setNameservers
};
