import exceljs from 'exceljs';
import moment from 'moment-timezone';
import { temporaryFile } from 'tempy';

import { mapColumnHeaders, rowToTicket } from '../domain/ticket.js';
import { PRIORITY, KEYWORDS, DATE_FORMAT } from '../domain/slaPolicy.js';
import { buildTimeline } from '../domain/lifecycle.js';
import { classifySla } from '../domain/slaRules.js';
import { isVipCaller, classifyVip } from '../domain/vip.js';
import { buildEmailToCountryMap, resolveCountry } from '../domain/countryResolver.js';
import { normalizeKeywords, initCountryTopicCounts, countTopics } from '../domain/topics.js';
import { createAggregates, hasCountryBuckets, ensureCountryBuckets, recordTicketAggregates } from '../domain/aggregates.js';
import { createCallerCount, recordCaller } from '../domain/callers.js';

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
    let priority3TicketsCount = 0;
    let priority4TicketsCount = 0;

    // Diccionarios $O(1)$ para acceso ultrarrápido
    // (construcción delegada a domain/countryResolver.js)
    const emailToCountryMap = buildEmailToCountryMap(emailCountries);

    // Taxonomía de palabras clave — se mantiene el orden del motor original:
    // afecta tanto la distribución por país como el layout de "Top 10 Topics".
    const wordsToSearch = KEYWORDS;
    const wordsToSearchLower = normalizeKeywords(wordsToSearch);

    // Contadores unificados (estructuras y lógica delegadas a domain/aggregates.js)
    const aggregates = createAggregates();
    let wordCountsByCountry = {};
    const callerCount = createCallerCount();

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

    // --- FASE 1: MAPEO DE CABECERAS (Robusto contra desorden) ---
    // Delegado a domain/ticket.js. Reemplazamos el objeto local con el devuelto.
    Object.assign(columnHeaders, mapColumnHeaders(sheet));

    // --- FASE 2: EL BUCLE ÚNICO (SINGLE-PASS PIPELINE) ---
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
        
        // Liberar el Event Loop cada 500 filas para evitar caídas por Timeout en el servidor
        if (rowNumber % 500 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }

        const row = sheet.getRow(rowNumber);
        if (!row.hasValues) continue;

        // Extraer objeto de la fila (delegado a domain/ticket.js)
        const ticket = rowToTicket(row, columnHeaders);

        const email = ticket["Email"] ? ticket["Email"].toString().trim() : "";
        
        // 1. Filtro inmediato: Si está excluido, saltamos al siguiente ticket (Ahorro masivo de procesamiento)
        if (excludedEmails.includes(email)) continue;

        const priority = ticket.Priority;
        if (priority === PRIORITY.P3) priority3TicketsCount++;
        if (priority === PRIORITY.P4) priority4TicketsCount++;

        // 2. Normalización de País (delegado a domain/countryResolver.js)
        //    Preserva la mutación in-place sobre ticket.Country.
        const currentCountry = resolveCountry(ticket, email, emailToCountryMap, allowedCountries);

        // 3. Reconstrucción de la línea de tiempo del ticket
        //    (regex + TZ math delegado a domain/lifecycle.js)
        const {
            date1, date2, date3,
            creationDate, resolutionDate,
            ticketMovedDate, analystUpdateDate, warrantyClaimDate
        } = buildTimeline(ticket, emailTimeZoneMappings, email);

        // 4. Clasificación SLA (delegado a domain/slaRules.js)
        const {
            responseSLA,
            resolutionSLA,
            warrantySLAStatus,
            differenceFromUpdated,
            differenceFromCreated,
            warrantyDifference
        } = classifySla({
            priority,
            date2,
            ticketMovedDate,
            analystUpdateDate,
            resolutionDate,
            warrantyClaimDate
        });

        // 4b. Elevación y veredicto VIP (delegado a domain/vip.js)
        const callerNameRaw = ticket.Caller || "";
        const isVip = isVipCaller(callerNameRaw, vipUsers);
        const { responseVip, resolvedVip } = classifyVip({
            isVip,
            analystUpdateDate,
            differenceFromUpdated,
            differenceFromCreated
        });

        // 5. Inserción Directa en la Hoja Raw
        // NOTA: Usamos addRow (append) en lugar de insertRow para evitar el
        // desplazamiento O(n) por fila que degrada el tiempo total a O(n^2).
        // Semánticamente equivalente: escribimos filas en orden ascendente.
        slaWorksheet.addRow([
            ticket.Number,
            priority,
            currentCountry,
            callerNameRaw,
            ticket["Assigned to"],
            ticket["Short description"],
            ticket["Description"],
            creationDate.format(DATE_FORMAT.output),
            date1,
            analystUpdateDate ? analystUpdateDate.format(DATE_FORMAT.output) : "",
            date2,
            warrantyClaimDate ? warrantyClaimDate.format(DATE_FORMAT.output) : "",
            resolutionDate.format(DATE_FORMAT.output),
            differenceFromUpdated !== null ? differenceFromUpdated : "",
            differenceFromCreated,
            warrantyDifference !== null ? warrantyDifference : "",
            responseSLA,
            resolutionSLA,
            responseVip,
            resolvedVip,
            warrantySLAStatus
        ]);

        // 6+7. Agregación global y por país (delegado a domain/aggregates.js).
        //      Inicialización per-country gated: aggregates lleva sus tres
        //      stores, topics lleva el suyo, cada módulo posee su propia forma.
        if (!hasCountryBuckets(aggregates, currentCountry)) {
            ensureCountryBuckets(aggregates, currentCountry);
            initCountryTopicCounts(wordCountsByCountry, currentCountry, wordsToSearchLower);
        }
        recordTicketAggregates(aggregates, {
            priority,
            responseSLA,
            resolutionSLA,
            warrantySLAStatus,
            isVip,
            country: currentCountry
        });

        // 8. Caller Count (delegado a domain/callers.js)
        recordCaller(callerCount, ticket.Caller, currentCountry);

        // 9. Conteo de Palabras (delegado a domain/topics.js)
        countTopics(ticket, currentCountry, wordCountsByCountry, wordsToSearchLower);

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
    
    // Aliases para el bloque de dashboard. Apuntan a los stores dentro de
    // `aggregates` (domain/aggregates.js) preservando exactamente los
    // mismos paths de lectura que existían antes de la extracción.
    const slaTotals = aggregates.totals;
    const slaByCountryFulfilled = aggregates.byCountry.fulfilled;
    const slaByCountryUnfulfilled = aggregates.byCountry.unfulfilled;
    const slaByCountryManualReview = aggregates.byCountry.manualReview;

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