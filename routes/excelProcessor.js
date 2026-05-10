import exceljs from 'exceljs';
import moment from 'moment-timezone';
import { temporaryFile } from 'tempy';

function calculatePercentageSafe(totalItems, partialAmount) {
    if (totalItems === 0) return '0.00%';
    const percentage = (partialAmount / totalItems * 100).toFixed(2);
    return percentage + '%';
}

async function processExcelFile(filePath, vipUsers, emailTimeZoneMappings, excludedEmails, emailCountries, allowedCountries) {
    const originalWorkbook = new exceljs.Workbook();
    await originalWorkbook.xlsx.readFile(filePath);
    const sheet = originalWorkbook.worksheets[0];
    
    // --- INICIALIZACIÓN DE VARIABLES Y CACHÉS ---
    const columnHeaders = {};
    let totalTicketsCount = 0;
    let priority3TicketsCount = 0;
    let priority4TicketsCount = 0;

    // Diccionarios $O(1)$ para acceso ultrarrápido
    const emailToCountryMap = {};
    emailCountries.forEach(({ Email, Country }) => {
        emailToCountryMap[Email] = Country;
    });

    const vipNamesSet = new Set(vipUsers.map(v => v.name));
    const wordsToSearch = ["windows", "zscaler", "vpn", "internet", "impresora", "outlook", "sharepoint", "teams", "office", "sap", "pki", "excel", "word", "certificados", "onedrive", "equipo", "red", "celular", "móvil"];
    const wordsToSearchLower = wordsToSearch.map(w => w.toLowerCase());

    // Expresiones regulares
    const dateHtmlPattern = /<p>(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2})<\/p>/;
    const dateProcessPattern = /(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2})\s*[-?\\¡¿*+;:_{}[\]]\s*En proceso/i;
    const dateWarrantyPattern = /(\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2})\s*[-?\\¡¿*+;:_{}[\]]\s*(A garantia|Garantia)/i;

    // Contadores unificados
    let slaTotals = {
        Response: { p3Fulfilled: 0, p3Unfulfilled: 0, p4Fulfilled: 0, p4Unfulfilled: 0, vipFulfilled: 0, vipUnfulfilled: 0, manualReview: 0 },
        Resolution: { p3Fulfilled: 0, p3Unfulfilled: 0, p4Fulfilled: 0, p4Unfulfilled: 0, vipFulfilled: 0, vipUnfulfilled: 0 },
        Warranty: { fulfilled: 0, unfulfilled: 0 }
    };

    let slaByCountryFulfilled = {};
    let slaByCountryUnfulfilled = {};
    let slaByCountryManualReview = {};
    let wordCountsByCountry = {};
    const callerCount = {};

    // --- CONFIGURACIÓN DEL NUEVO WORKBOOK ---
    const slaWorkbook = new exceljs.Workbook();
    const slaWorksheet = slaWorkbook.addWorksheet('RawSLAData');
    
    const columnHeaderStyle = { font: { name: 'Arial', size: 10, bold: true } };
    const commonStyle = { font: { name: 'Arial', size: 10 } };

    const columnDefinitions = [
        { key: 'Number', width: 12.75 },
        { key: 'Priority', width: 8.75 },
        { key: 'Caller', width: 35.75 },
        { key: 'Assigned to', width: 35.75 },
        ...new Array(15).fill().map((_, index) => ({
            key: 'CELL1',
            width: index < 6 ? 18.75 : 15.75
        }))
    ];

    slaWorksheet.columns = columnDefinitions.map(col => ({ ...col, style: commonStyle }));
    slaWorksheet.getRow(1).values = ['Number', 'Priority', 'Country', 'Caller', 'Assigned to', 'Short description', 'Description','Created', 'TeamAssignmentDate', 'LastSystemUpdateDate', 'AnalystResponseDate', 'WarrantyDate', 'Resolved', 'ResponseTimeMins', 'ResolutionTimeMins', 'WarrantyTimeMins', 'ResponseSLA', 'ResolutionSLA', 'VIPResponseSLA', 'VIPResolutionSLA', 'WarrantySLA'];
    slaWorksheet.getRow(1).eachCell(cell => { cell.style = columnHeaderStyle; });

    const dashboardTimeZone = 'US/Central';

    // --- FASE 1: MAPEO DE CABECERAS (Robusto contra desorden) ---
    sheet.getRow(1).eachCell((cell, colNumber) => {
        if (cell.value) {
            columnHeaders[colNumber] = cell.value.toString().trim();
        }
    });

    let outputRowIndex = 2; // Índice para insertar en el nuevo Excel

    // --- FASE 2: EL BUCLE ÚNICO (SINGLE-PASS PIPELINE) ---
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
        
        // Liberar el Event Loop cada 500 filas para evitar caídas por Timeout en el servidor
        if (rowNumber % 500 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }

        const row = sheet.getRow(rowNumber);
        if (!row.hasValues) continue;

        // Extraer objeto de la fila
        const ticket = {};
        row.eachCell((cell, colNumber) => {
            const headerName = columnHeaders[colNumber];
            if (headerName) ticket[headerName] = cell.value;
        });

        const email = ticket["Email"] ? ticket["Email"].toString().trim() : "";
        
        // 1. Filtro inmediato: Si está excluido, saltamos al siguiente ticket (Ahorro masivo de procesamiento)
        if (excludedEmails.includes(email)) continue;

        totalTicketsCount++;
        const priority = ticket.Priority;
        if (priority === "3 - Moderate") priority3TicketsCount++;
        if (priority === "4 - Low") priority4TicketsCount++;

        // 2. Normalización de País
        const callerCountry = emailToCountryMap[email];
        let currentCountry = ticket.Country;
        if (!allowedCountries.includes(currentCountry)) {
            currentCountry = callerCountry || '#';
            ticket.Country = currentCountry;
        }

        // 3. Extracción de Fechas por Regex
        const additionalContent = ticket["Additional content"] || "";
        const additionalComments = ticket["Additional comments"] || "";
        
        const matchContent = additionalContent.match(dateHtmlPattern);
        const matchProcess = additionalComments.match(dateProcessPattern);
        const matchWarranty = additionalComments.match(dateWarrantyPattern);

        const date1 = matchContent ? matchContent[1] : "";
        const date2 = matchProcess ? matchProcess[1] : "";
        const date3 = matchWarranty ? matchWarranty[1] : "";

        // 4. Cálculos de Tiempos y Zonas Horarias
        let ticketUpdaterTimeZone = emailTimeZoneMappings[email];
        let creationDate = moment(ticket.Created, 'YYYY-MM-DD HH:mm:ss');
        let resolutionDate = moment(ticket.Resolved, 'YYYY-MM-DD HH:mm:ss');

        let ticketMovedDate = date1 
            ? moment.tz(date1, 'DD-MM-YYYY HH:mm:ss', ticketUpdaterTimeZone).tz(dashboardTimeZone)
            : creationDate;

        let analystUpdateDate = null;
        let responseSLA = "Revisar manualmente";
        let differenceFromUpdated = null;

        if (date2) {
            analystUpdateDate = moment.tz(date2, 'DD-MM-YYYY HH:mm:ss', ticketUpdaterTimeZone).tz(dashboardTimeZone);
            differenceFromUpdated = analystUpdateDate.diff(ticketMovedDate, 'minutes');

            if (priority === '3 - Moderate') {
                responseSLA = differenceFromUpdated <= 120 ? "fulfilled" : "unfulfilled";
            } else if (priority === '4 - Low') {
                responseSLA = differenceFromUpdated <= 180 ? "fulfilled" : "unfulfilled";
            }
        }

        let warrantyClaimDate = date3 ? moment.tz(date3, 'DD-MM-YYYY HH:mm:ss', ticketUpdaterTimeZone).tz(dashboardTimeZone) : null;
        let differenceFromCreated = resolutionDate.diff(ticketMovedDate, 'minutes');
        
        let warrantyDifference = null;
        let warrantySLAStatus = "";
        if (warrantyClaimDate) {
            warrantyDifference = warrantyClaimDate.diff(ticketMovedDate, 'minutes');
            warrantySLAStatus = warrantyDifference <= 120 ? "fulfilled" : "unfulfilled";
        }

        let resolutionSLA = "unfulfilled";
        if (priority === '3 - Moderate') {
            resolutionSLA = differenceFromCreated <= 480 ? "fulfilled" : "unfulfilled";
        } else if (priority === '4 - Low') {
            resolutionSLA = differenceFromCreated <= 960 ? "fulfilled" : "unfulfilled";
        }

        const callerNameRaw = ticket.Caller || "";
        let isVip = false;
        // Optimización: Set lookup is faster than Array.some if exact match, but since it's "includes", we keep iteration.
        for(let vip of vipUsers) {
            if (callerNameRaw.includes(vip.name)) {
                isVip = true;
                break;
            }
        }

        let responseVip = isVip ? "Revisar manualmente" : "";
        let resolvedVip = "";

        if (isVip && analystUpdateDate) {
            responseVip = differenceFromUpdated <= 30 ? "fulfilled" : "unfulfilled";
            resolvedVip = differenceFromCreated <= 480 ? "fulfilled" : "unfulfilled";
        }

        // 5. Inserción Directa en la Hoja Raw
        slaWorksheet.insertRow(outputRowIndex++, [
            ticket.Number,
            priority,
            currentCountry,
            callerNameRaw,
            ticket["Assigned to"],
            ticket["Short description"],
            ticket["Description"],
            creationDate.format('DD-MM-YYYY HH:mm:ss'),
            date1,
            analystUpdateDate ? analystUpdateDate.format('DD-MM-YYYY HH:mm:ss') : "",
            date2,
            warrantyClaimDate ? warrantyClaimDate.format('DD-MM-YYYY HH:mm:ss') : "",
            resolutionDate.format('DD-MM-YYYY HH:mm:ss'),
            differenceFromUpdated !== null ? differenceFromUpdated : "",
            differenceFromCreated,
            warrantyDifference !== null ? warrantyDifference : "",
            responseSLA,
            resolutionSLA,
            responseVip,
            resolvedVip,
            warrantySLAStatus
        ]);

        // 6. Actualización de Contadores Globales
        if (responseSLA === "fulfilled") {
            if (priority === '3 - Moderate') slaTotals.Response.p3Fulfilled++;
            else if (priority === '4 - Low') slaTotals.Response.p4Fulfilled++;
            if (isVip) slaTotals.Response.vipFulfilled++;
        } else if (responseSLA === "unfulfilled") {
            if (priority === '3 - Moderate') slaTotals.Response.p3Unfulfilled++;
            else if (priority === '4 - Low') slaTotals.Response.p4Unfulfilled++;
            if (isVip) slaTotals.Response.vipUnfulfilled++;
        } else if (responseSLA === "Revisar manualmente") {
            slaTotals.Response.manualReview++;
        }

        if (resolutionSLA === "fulfilled") {
            if (priority === '3 - Moderate') slaTotals.Resolution.p3Fulfilled++;
            else if (priority === '4 - Low') slaTotals.Resolution.p4Fulfilled++;
            if (isVip) slaTotals.Resolution.vipFulfilled++;
        } else {
            if (priority === '3 - Moderate') slaTotals.Resolution.p3Unfulfilled++;
            else if (priority === '4 - Low') slaTotals.Resolution.p4Unfulfilled++;
            if (isVip) slaTotals.Resolution.vipUnfulfilled++;
        }

        if (warrantySLAStatus === "fulfilled") slaTotals.Warranty.fulfilled++;
        else if (warrantySLAStatus === "unfulfilled") slaTotals.Warranty.unfulfilled++;

        // 7. Inicialización Segura y Actualización de Contadores por País
        if (!slaByCountryFulfilled[currentCountry]) {
            slaByCountryFulfilled[currentCountry] = { Response: { p3: 0, p4: 0, vip: 0 }, Resolution: { p3: 0, p4: 0, vip: 0 }, Warranty: { fulfilled: 0 } };
            slaByCountryUnfulfilled[currentCountry] = { Response: { p3: 0, p4: 0, vip: 0 }, Resolution: { p3: 0, p4: 0, vip: 0 }, Warranty: { unfulfilled: 0 } };
            slaByCountryManualReview[currentCountry] = { Response: { p3: 0, p4: 0, vip: 0 } };
            wordCountsByCountry[currentCountry] = {};
            wordsToSearchLower.forEach(w => wordCountsByCountry[currentCountry][w] = 0);
        }

        if (responseSLA === "fulfilled") {
            if (priority === '3 - Moderate') slaByCountryFulfilled[currentCountry].Response.p3++;
            else if (priority === '4 - Low') slaByCountryFulfilled[currentCountry].Response.p4++;
            if (isVip) slaByCountryFulfilled[currentCountry].Response.vip++;
        } else if (responseSLA === "unfulfilled") {
            if (priority === '3 - Moderate') slaByCountryUnfulfilled[currentCountry].Response.p3++;
            else if (priority === '4 - Low') slaByCountryUnfulfilled[currentCountry].Response.p4++;
            if (isVip) slaByCountryUnfulfilled[currentCountry].Response.vip++;
        } else if (responseSLA === "Revisar manualmente") {
            if (priority === '3 - Moderate') slaByCountryManualReview[currentCountry].Response.p3++;
            else if (priority === '4 - Low') slaByCountryManualReview[currentCountry].Response.p4++;
            if (isVip) slaByCountryManualReview[currentCountry].Response.vip++;
        }

        if (resolutionSLA === "fulfilled") {
            if (priority === '3 - Moderate') slaByCountryFulfilled[currentCountry].Resolution.p3++;
            else if (priority === '4 - Low') slaByCountryFulfilled[currentCountry].Resolution.p4++;
            if (isVip) slaByCountryFulfilled[currentCountry].Resolution.vip++;
        } else {
            if (priority === '3 - Moderate') slaByCountryUnfulfilled[currentCountry].Resolution.p3++;
            else if (priority === '4 - Low') slaByCountryUnfulfilled[currentCountry].Resolution.p4++;
            if (isVip) slaByCountryUnfulfilled[currentCountry].Resolution.vip++;
        }

        if (warrantySLAStatus === "fulfilled") slaByCountryFulfilled[currentCountry].Warranty.fulfilled++;
        else if (warrantySLAStatus === "unfulfilled") slaByCountryUnfulfilled[currentCountry].Warranty.unfulfilled++;

        // 8. Caller Count Optimizado
        const callerName = ticket.Caller || "Unknown";
        if (!callerCount[callerName]) {
            callerCount[callerName] = { count: 0, country: currentCountry };
        }
        callerCount[callerName].count++;

        // 9. Conteo de Palabras Optimizado
        const shortDesc = (ticket["Short description"] || "").toLowerCase();
        const desc = (ticket.Description || "").toLowerCase();
        
        // Solo evalúa los "includes" una vez para ver si hay que revisar la descripción general
        const hasAnyWordInShort = wordsToSearchLower.some(w => shortDesc.includes(w));
        
        wordsToSearchLower.forEach(wordLower => {
            if (shortDesc.includes(wordLower)) {
                wordCountsByCountry[currentCountry][wordLower]++;
            } else if (!hasAnyWordInShort && desc.includes(wordLower)) {
                wordCountsByCountry[currentCountry][wordLower]++;
            }
        });
        
    } // FIN BUCLE PRINCIPAL

    console.log(`Finalizados los cálculos. Escribiendo resultados...`);

    // --- GENERACIÓN DE HOJA: TOP 10 TOPICS ---
    const countWorksheet = slaWorkbook.addWorksheet('Top 10 Topics');
    const headers = [];
    Object.keys(wordCountsByCountry).forEach(country => {
        headers.push({ header: country, key: `${country}_word` }, { header: ``, key: `${country}_count` });
    });
    countWorksheet.columns = headers;
    countWorksheet.addRow(["Topico", "#", "Topico", "#", "Topico", "#", "Topico", "#", "Topico", "#", "Topico", "#", "Topico", "#", "Topico", "#", "Topico", "#"]);

    if (Object.keys(wordCountsByCountry).length > 0) {
        // Encontrar las 10 palabras más buscadas por país
        const topWordsByCountry = {};
        Object.keys(wordCountsByCountry).forEach(country => {
            const wordCounts = wordCountsByCountry[country];
            const sortedWords = Object.keys(wordCounts).sort((a, b) => wordCounts[b] - wordCounts[a]).slice(0, 10);
            topWordsByCountry[country] = sortedWords.map(word => ({ word, count: wordCounts[word] }));
        });

        const words = wordsToSearchLower.slice(0, 10); // Iterar sobre los índices 0 a 9
        words.forEach((_, index) => {
            const rowData = {};
            Object.keys(topWordsByCountry).forEach(country => {
                if (topWordsByCountry[country][index]) {
                    rowData[`${country}_word`] = topWordsByCountry[country][index].word;
                    rowData[`${country}_count`] = topWordsByCountry[country][index].count;
                }
            });
            countWorksheet.addRow(rowData);
        });
    }

    // --- GENERACIÓN DE HOJA: TOP 10 CALLERS ---
    const topWorksheet = slaWorkbook.addWorksheet('Top 10 Callers');
    const sortedCounts = Object.entries(callerCount).sort((a, b) => b[1].count - a[1].count);
    const top10Callers = sortedCounts.slice(0, 10);

    const headerStyle = { font: { name: 'Roboto', size: 10, bold: true } };
    topWorksheet.columns = new Array(4).fill().map(() => ({ style: headerStyle }));
    topWorksheet.addRow(["#", "Caller", "Country", "Tickets"]);

    const thirdCommonStyle = { font: { name: 'Roboto', size: 10 } };
    topWorksheet.columns = new Array(4).fill().map(() => ({ style: thirdCommonStyle }));

    top10Callers.forEach(([caller, data], index) => {
        topWorksheet.addRow([index + 1, caller.toUpperCase(), data.country, data.count]);
    });
    topWorksheet.columns = [{ width: 3 }, { width: 65 }, { width: 10 }, { width: 10 }];

    // --- GENERACIÓN DE HOJA: DASHBOARD SLA DATA ---
    const dashboardWorksheet = slaWorkbook.addWorksheet('DashboardSLAData');
    dashboardWorksheet.columns = columnDefinitions.map(col => ({ ...col, style: commonStyle }));
    dashboardWorksheet.columns = new Array(25).fill().map(() => ({ style: columnHeaderStyle }));
    
    const rowValues = [null, "SLA Response P3", null, "SLA Resolution P3", null, "SLA Response P4", null, "SLA Resolution P4", null, "SLA Response VIP", null, "SLA Resolution VIP", null, "SLA Break & Fix", null];
    const row = dashboardWorksheet.addRow(rowValues);

    dashboardWorksheet.mergeCells(`B${row.number}:C${row.number}`);
    dashboardWorksheet.mergeCells(`D${row.number}:E${row.number}`);
    dashboardWorksheet.mergeCells(`F${row.number}:G${row.number}`);
    dashboardWorksheet.mergeCells(`H${row.number}:I${row.number}`);
    dashboardWorksheet.mergeCells(`J${row.number}:K${row.number}`);
    dashboardWorksheet.mergeCells(`L${row.number}:M${row.number}`);
    dashboardWorksheet.mergeCells(`N${row.number}:O${row.number}`);

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber >= 2 && colNumber <= 16) cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const rowValues2 = [null, "Fulfilled", "Unfulfilled", "Fulfilled", "Unfulfilled", "Fulfilled", "Unfulfilled", "Fulfilled", "Unfulfilled", "Fulfilled", "Unfulfilled", "Fulfilled", "Unfulfilled", "Fulfilled", "Unfulfilled"];
    const row2 = dashboardWorksheet.addRow(rowValues2);

    row2.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber >= 2 && colNumber <= 16) cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    const secondCommonStyle = { font: { name: 'Arial', size: 10 }, alignment: { horizontal: 'center', vertical: 'middle' } };
    dashboardWorksheet.columns = columnDefinitions.map(col => ({ ...col, style: secondCommonStyle, width: 12.75 }));
    
    dashboardWorksheet.addRow([
        null,
        slaTotals.Response.p3Fulfilled, slaTotals.Response.p3Unfulfilled,
        slaTotals.Resolution.p3Fulfilled, slaTotals.Resolution.p3Unfulfilled,
        slaTotals.Response.p4Fulfilled, slaTotals.Response.p4Unfulfilled,
        slaTotals.Resolution.p4Fulfilled, slaTotals.Resolution.p4Unfulfilled,
        slaTotals.Response.vipFulfilled, slaTotals.Response.vipUnfulfilled,
        slaTotals.Resolution.vipFulfilled, slaTotals.Resolution.vipUnfulfilled,
        slaTotals.Warranty.fulfilled, slaTotals.Warranty.unfulfilled
    ]);
    
    dashboardWorksheet.addRow([
        null,
        calculatePercentageSafe(priority3TicketsCount, slaTotals.Response.p3Fulfilled),
        calculatePercentageSafe(priority3TicketsCount, slaTotals.Response.p3Unfulfilled),
        calculatePercentageSafe(priority3TicketsCount, slaTotals.Resolution.p3Fulfilled),
        calculatePercentageSafe(priority3TicketsCount, slaTotals.Resolution.p3Unfulfilled),
        calculatePercentageSafe(priority4TicketsCount, slaTotals.Response.p4Fulfilled),
        calculatePercentageSafe(priority4TicketsCount, slaTotals.Response.p4Unfulfilled),
        calculatePercentageSafe(priority4TicketsCount, slaTotals.Resolution.p4Fulfilled),
        calculatePercentageSafe(priority4TicketsCount, slaTotals.Resolution.p4Unfulfilled),
        calculatePercentageSafe(slaTotals.Response.vipFulfilled + slaTotals.Response.vipUnfulfilled + slaTotals.Response.manualReview, slaTotals.Response.vipFulfilled),
        calculatePercentageSafe(slaTotals.Response.vipFulfilled + slaTotals.Response.vipUnfulfilled + slaTotals.Response.manualReview, slaTotals.Response.vipUnfulfilled),
        calculatePercentageSafe(slaTotals.Resolution.vipFulfilled + slaTotals.Resolution.vipUnfulfilled, slaTotals.Resolution.vipFulfilled),
        calculatePercentageSafe(slaTotals.Resolution.vipFulfilled + slaTotals.Resolution.vipUnfulfilled, slaTotals.Resolution.vipUnfulfilled),
        calculatePercentageSafe(slaTotals.Warranty.fulfilled + slaTotals.Warranty.unfulfilled, slaTotals.Warranty.fulfilled),
        calculatePercentageSafe(slaTotals.Warranty.fulfilled + slaTotals.Warranty.unfulfilled, slaTotals.Warranty.unfulfilled)
    ]);

    let rowNum = 5;
    for (const country in slaByCountryFulfilled) {
        dashboardWorksheet.addRow([country,
            slaByCountryFulfilled[country].Response.p3, slaByCountryUnfulfilled[country].Response.p3,
            slaByCountryFulfilled[country].Resolution.p3, slaByCountryUnfulfilled[country].Resolution.p3,
            slaByCountryFulfilled[country].Response.p4, slaByCountryUnfulfilled[country].Response.p4,
            slaByCountryFulfilled[country].Resolution.p4, slaByCountryUnfulfilled[country].Resolution.p4,
            slaByCountryFulfilled[country].Response.vip, slaByCountryUnfulfilled[country].Response.vip,
            slaByCountryFulfilled[country].Resolution.vip, slaByCountryUnfulfilled[country].Resolution.vip,
            slaByCountryFulfilled[country].Warranty.fulfilled, slaByCountryUnfulfilled[country].Warranty.unfulfilled
        ]);
        
        dashboardWorksheet.addRow([null,
            calculatePercentageSafe(priority3TicketsCount, slaByCountryFulfilled[country].Response.p3),
            calculatePercentageSafe(priority3TicketsCount, slaByCountryUnfulfilled[country].Response.p3),
            calculatePercentageSafe(priority3TicketsCount, slaByCountryFulfilled[country].Resolution.p3),
            calculatePercentageSafe(priority3TicketsCount, slaByCountryUnfulfilled[country].Resolution.p3),
            calculatePercentageSafe(priority4TicketsCount, slaByCountryFulfilled[country].Response.p4),
            calculatePercentageSafe(priority4TicketsCount, slaByCountryUnfulfilled[country].Response.p4),
            calculatePercentageSafe(priority4TicketsCount, slaByCountryFulfilled[country].Resolution.p4),
            calculatePercentageSafe(priority4TicketsCount, slaByCountryUnfulfilled[country].Resolution.p4),
            calculatePercentageSafe(slaByCountryFulfilled[country].Response.vip + slaByCountryUnfulfilled[country].Response.vip + slaByCountryManualReview[country].Response.vip, slaByCountryFulfilled[country].Response.vip),
            calculatePercentageSafe(slaByCountryFulfilled[country].Response.vip + slaByCountryUnfulfilled[country].Response.vip + slaByCountryManualReview[country].Response.vip, slaByCountryUnfulfilled[country].Response.vip),
            calculatePercentageSafe(slaByCountryFulfilled[country].Resolution.vip + slaByCountryUnfulfilled[country].Resolution.vip, slaByCountryFulfilled[country].Resolution.vip),
            calculatePercentageSafe(slaByCountryFulfilled[country].Resolution.vip + slaByCountryUnfulfilled[country].Resolution.vip, slaByCountryUnfulfilled[country].Resolution.vip),
            calculatePercentageSafe(slaByCountryFulfilled[country].Warranty.fulfilled + slaByCountryUnfulfilled[country].Warranty.unfulfilled, slaByCountryFulfilled[country].Warranty.fulfilled),
            calculatePercentageSafe(slaByCountryFulfilled[country].Warranty.fulfilled + slaByCountryUnfulfilled[country].Warranty.unfulfilled, slaByCountryUnfulfilled[country].Warranty.unfulfilled)
        ]);

        dashboardWorksheet.mergeCells(`A${rowNum}:A${rowNum + 1}`);
        const mergedCell = dashboardWorksheet.getCell(`A${rowNum}`);
        mergedCell.alignment = { vertical: 'middle', horizontal: 'center' };
        rowNum += 2;
    }

    // Auto-ajuste visual de anchos de columna en RAW Data
    slaWorksheet.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
            let columnLength = (cell.value && cell.value.toString().length) || 10;
            if (columnLength > maxLength) maxLength = columnLength;
        });
        column.width = maxLength < 10 ? 10 : Math.min(maxLength + 2, 50); // Límite de ancho para evitar columnas excesivas
    });

    const now = new Date();
    const formattedDate = moment(now).format('YYYY-MM-DD HH-mm-ss');
    const tempFilePath = await temporaryFile({ name: `SLA_${formattedDate}.xlsx` });

    await slaWorkbook.xlsx.writeFile(tempFilePath);
    return tempFilePath;
}

export default processExcelFile;