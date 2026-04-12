const axios = require('axios');
const xml2js = require('xml2js');

// Configuration
const API_KEY = '6E8g8q9C9A7u9U7xTYW7kMh846t8W9XDV6r7l8c7d'; // Your production key
const BASE_URL = 'https://api.dynadot.com/api3.xml'; // Using XML endpoint as JSON might be less stable or structured differently in docs, but docs say JSON is available. Let's try XML parsing to be safe as search results showed XML examples.
// Actually, search results showed JSON example: https://api.dynadot.com/api3.json?key=...
// Let's use JSON if possible for easier parsing, but fallback to XML if needed.
// The user prompt mentioned JSON. Let's try JSON first.
const BASE_URL_JSON = 'https://api.dynadot.com/api3.json';

const dynadot = {
    /**
     * Search for a domain (single or multiple TLDs)
     * @param {string} domain 
     * @returns {Promise<Array<{available: boolean, price: string, currency: string, domain: string, error?: string}>>}
     */
    searchDomain: async (domain) => {
        try {
            const tlds = [
                '.sbs', '.cyou', '.cfd', '.click', '.xyz', '.lol', '.rest', '.homes', '.lat', 
                '.autos', '.quest', '.forum', '.baby', '.monster', '.pics', '.mom', '.hair', 
                '.life', '.one', '.my', '.blog', '.vip', '.art', '.biz', '.love', '.news', 
                '.dance', '.com', '.net', '.org', '.info'
            ];
            let domainsToCheck = [];

            if (!domain.includes('.')) {
                domainsToCheck = tlds.map(tld => `${domain}${tld}`);
            } else {
                domainsToCheck = [domain];
            }

            let finalResults = [];

            for (const d of domainsToCheck) {
                console.log(`[DYNADOT_SEARCH] Checking: ${d}`);

                try {
                    const response = await axios.get(BASE_URL_JSON, {
                        params: {
                            key: API_KEY,
                            command: 'search',
                            domain0: d,
                            show_price: 1,
                            currency: 'USD'
                        },
                        timeout: 10000
                    });

                    const data = response.data;
                    if (!data) {
                        console.log(`[DYNADOT_DEBUG] No data returned for ${d}`);
                        continue;
                    }

                    console.log(`[DYNADOT_RAW] Response for ${d}:`, JSON.stringify(data));

                    if (data.SearchResponse) {
                        const sr = data.SearchResponse;
                        const responseCode = sr.ResponseCode || (sr.SearchHeader ? sr.SearchHeader.SuccessCode : null);
                        
                        if (responseCode === '0' || responseCode === 0) {
                            let results = sr.SearchResults || [];
                            if (results.length === 0 && sr.SearchHeader) {
                                results = [sr.SearchHeader];
                            }

                            for (const res of results) {
                                let numericPrice = null;
                                let priceStr = res.Price || (sr.SearchHeader ? sr.SearchHeader.Price : null);
                                
                                if (priceStr) {
                                    const regPriceMatch = priceStr.match(/Registration Price:\s*([\d.]+)/i) || priceStr.match(/[\d.]+/);
                                    if (regPriceMatch) {
                                        numericPrice = parseFloat(regPriceMatch[1] || regPriceMatch[0]);
                                    }
                                }

                                finalResults.push({
                                    available: res.Available === 'yes',
                                    price: numericPrice ? numericPrice.toFixed(2) : 'N/A',
                                    numericPrice: numericPrice,
                                    currency: 'USD',
                                    domain: res.DomainName || d
                                });
                            }
                        } else {
                            console.log(`[DYNADOT_DEBUG] API Error for ${d}: ${sr.Error || 'Unknown Error'}`);
                        }
                    }
                } catch (e) {
                    console.error(`[DYNADOT_ERROR] Search failed for ${d}:`, e.message);
                }

                await new Promise(resolve => setTimeout(resolve, 300));
            }
            
            const filtered = finalResults.filter(result => {
                console.log(`[DYNADOT_FILTER] Checking: ${result.domain} | Available: ${result.available} | Price: ${result.price}`);
                
                if (result.available && result.numericPrice !== null) {
                    const isCheap = result.numericPrice <= 10.00;
                    if (!isCheap) {
                        console.log(`[DYNADOT_FILTER] Hiding ${result.domain}: Price $${result.numericPrice} > $10.00`);
                    }
                    return isCheap;
                }
                
                console.log(`[DYNADOT_FILTER] Hiding ${result.domain}: Not available or no price`);
                return false; 
            });

            return filtered.length > 0 ? filtered : finalResults;

        } catch (error) {
            console.error('Dynadot Search Error:', error.message);
            return [{ available: false, error: error.message }];
        }
    },

    /**
     * Register a domain using account balance
     * @param {string} domain 
     * @param {number} duration (years)
     * @returns {Promise<{success: boolean, message: string, expiration: number, orderId?: string}>}
     */
    registerDomain: async (domain, duration = 1) => {
        try {
            console.log(`[DYNADOT_REGISTER] Attempting to register: ${domain} for ${duration} year(s)`);
            
            const response = await axios.get(BASE_URL_JSON, {
                params: {
                    key: API_KEY,
                    command: 'register',
                    domain: domain,
                    duration: duration,
                    currency: 'USD'
                },
                timeout: 30000
            });

            const data = response.data;
            console.log(`[DYNADOT_REGISTER] Response:`, JSON.stringify(data));
            
            if (data.RegisterResponse) {
                const header = data.RegisterResponse.RegisterHeader;
                const content = data.RegisterResponse.RegisterContent;
                
                if (header && (header.SuccessCode == 0 || header.SuccessCode === '0' || header.Status === 'success')) {
                    return { 
                        success: true, 
                        message: 'Domain registered successfully using account balance',
                        expiration: content ? content.Expiration : null,
                        orderId: content ? content.OrderId : null
                    };
                } else {
                    const errorMsg = (header ? header.Error : null) || data.RegisterResponse.Error || 'Registration failed';
                    return { success: false, message: errorMsg };
                }
            }

            return { success: false, message: 'Invalid API Response' };

        } catch (error) {
            console.error('Dynadot Register Error:', error.message);
            return { success: false, message: error.message };
        }
    },

    /**
     * Set Nameservers for a domain
     * @param {string} domain 
     * @param {string[]} nameservers 
     * @returns {Promise<{success: boolean, message: string}>}
     */
    setNameservers: async (domain, nameservers) => {
        try {
            console.log(`[DYNADOT_SET_NS] Setting nameservers for ${domain}:`, nameservers);
            
            const params = {
                key: API_KEY,
                command: 'set_ns',
                domain: domain
            };

            // Dynadot expects ns0, ns1, ns2...
            nameservers.forEach((ns, index) => {
                if (ns && ns.trim()) {
                    params[`ns${index}`] = ns.trim();
                }
            });

            console.log(`[DYNADOT_SET_NS] Request params:`, params);

            const response = await axios.get(BASE_URL_JSON, { 
                params,
                timeout: 15000 
            });
            
            const data = response.data;
            console.log(`[DYNADOT_SET_NS] Response:`, JSON.stringify(data));

            if (data.SetNsResponse) {
                const header = data.SetNsResponse.SetNsHeader;
                if (header && (header.SuccessCode == 0 || header.SuccessCode === '0' || header.Status === 'success')) {
                    return { success: true, message: 'Nameservers updated successfully' };
                } else {
                    const errorMsg = (header ? header.Error : null) || data.SetNsResponse.Error || 'Update failed';
                    return { success: false, message: errorMsg };
                }
            }
            
            return { success: false, message: 'Invalid API Response' };

        } catch (error) {
            console.error('Dynadot SetNS Error:', error.message);
            return { success: false, message: error.message };
        }
    },

    /**
     * Get Account Balance
     * @returns {Promise<string>}
     */
    getBalance: async () => {
        try {
            const response = await axios.get(BASE_URL_JSON, {
                params: {
                    key: API_KEY,
                    command: 'get_account_balance'
                },
                timeout: 10000
            });
            
            const data = response.data;
            console.log(`[DYNADOT_BALANCE] Response:`, JSON.stringify(data));
            
            if (data.GetAccountBalanceResponse) {
                const content = data.GetAccountBalanceResponse.GetAccountBalanceContent;
                if (content && content.Balance) {
                    return content.Balance;
                }
                return data.GetAccountBalanceResponse.Balance || '0.00';
            }
            return '0.00';
        } catch (error) {
            console.error('Dynadot Balance Error:', error.message);
            return 'Error';
        }
    },

    /**
     * Get domain info (including current nameservers)
     * @param {string} domain
     * @returns {Promise<{success: boolean, nameservers: string[], message?: string}>}
     */
    getDomainInfo: async (domain) => {
        try {
            console.log(`[DYNADOT_INFO] Getting info for: ${domain}`);
            
            const response = await axios.get(BASE_URL_JSON, {
                params: {
                    key: API_KEY,
                    command: 'domain_info',
                    domain: domain
                },
                timeout: 10000
            });
            
            const data = response.data;
            console.log(`[DYNADOT_INFO] Response:`, JSON.stringify(data));
            
            if (data.DomainInfoResponse) {
                const header = data.DomainInfoResponse.DomainInfoHeader;
                const content = data.DomainInfoResponse.DomainInfoContent;
                
                if (header && (header.SuccessCode == 0 || header.SuccessCode === '0')) {
                    const nsList = [];
                    if (content) {
                        // Extract nameservers (ns0, ns1, ns2, ns3, ns4)
                        for (let i = 0; i <= 4; i++) {
                            if (content[`ns${i}`]) {
                                nsList.push(content[`ns${i}`]);
                            }
                        }
                    }
                    return { success: true, nameservers: nsList };
                } else {
                    return { success: false, nameservers: [], message: header?.Error || 'Failed to get domain info' };
                }
            }
            return { success: false, nameservers: [], message: 'Invalid API Response' };
        } catch (error) {
            console.error('Dynadot Domain Info Error:', error.message);
            return { success: false, nameservers: [], message: error.message };
        }
    },

    /**
     * List all domains in Dynadot account
     * @returns {Promise<{success: boolean, domains: string[], message?: string}>}
     */
    listDomains: async () => {
        try {
            console.log(`[DYNADOT_LIST] Starting listDomains function...`);
            console.log(`[DYNADOT_LIST] API Key (first 10 chars): ${API_KEY.substring(0, 10)}...`);
            console.log(`[DYNADOT_LIST] BASE_URL_JSON: ${BASE_URL_JSON}`);
            
            const params = {
                key: API_KEY,
                command: 'domain_list'
            };
            console.log(`[DYNADOT_LIST] Request params:`, JSON.stringify(params));
            
            const response = await axios.get(BASE_URL_JSON, {
                params: params,
                timeout: 30000
            });
            
            const data = response.data;
            console.log(`[DYNADOT_LIST] Full response:`, JSON.stringify(data));
            console.log(`[DYNADOT_LIST] Response keys:`, Object.keys(data));
            
            // Check if it's the old XML-style response wrapped in Response
            if (data.Response) {
                console.log(`[DYNADOT_LIST] Found 'Response' key - legacy format`);
                console.log(`[DYNADOT_LIST] ResponseCode:`, data.Response.ResponseCode);
                console.log(`[DYNADOT_LIST] Error:`, data.Response.Error);
                
                // If success code is 0, parse the content
                if (data.Response.ResponseCode === '0' || data.Response.ResponseCode === 0) {
                    const content = data.Response.Content;
                    console.log(`[DYNADOT_LIST] Content:`, JSON.stringify(content)?.substring(0, 500));
                    
                    const domains = [];
                    if (content && content.DomainNameList) {
                        content.DomainNameList.forEach(item => {
                            if (item.DomainName) {
                                domains.push(item.DomainName);
                            }
                        });
                    }
                    console.log(`[DYNADOT_LIST] SUCCESS - Found ${domains.length} domains:`, domains);
                    return { success: true, domains };
                }
                
                return { success: false, domains: [], message: data.Response.Error || 'API Error' };
            }
            
            if (data.GetDomainListResponse) {
                console.log(`[DYNADOT_LIST] Found GetDomainListResponse`);
                const header = data.GetDomainListResponse.GetDomainListHeader;
                const content = data.GetDomainListResponse.GetDomainListContent;
                
                console.log(`[DYNADOT_LIST] Header:`, JSON.stringify(header));
                console.log(`[DYNADOT_LIST] Content:`, JSON.stringify(content)?.substring(0, 300));
                
                if (header && (header.SuccessCode == 0 || header.SuccessCode === '0')) {
                    const domains = [];
                    if (content && content.DomainNameList) {
                        content.DomainNameList.forEach(item => {
                            if (item.DomainName) {
                                domains.push(item.DomainName);
                            }
                        });
                    }
                    console.log(`[DYNADOT_LIST] SUCCESS - Found ${domains.length} domains:`, domains);
                    return { success: true, domains };
                } else {
                    console.log(`[DYNADOT_LIST] API returned error:`, header?.Error);
                    return { success: false, domains: [], message: header?.Error || 'Failed to list domains' };
                }
            }
            
            console.log(`[DYNADOT_LIST] Unknown response structure`);
            return { success: false, domains: [], message: 'Invalid API Response structure' };
        } catch (error) {
            console.error('[DYNADOT_LIST] ERROR:', error.message);
            console.error('[DYNADOT_LIST] Error response:', error.response?.data);
            return { success: false, domains: [], message: error.message };
        }
    }
};

module.exports = dynadot;
