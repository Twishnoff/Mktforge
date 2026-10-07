# Company Brief — site files (drop into the Mktforge repo)

assets/js/config.js                      + companyBrief.API_BASE_URL
modules/my-company/my-company.js         + "Generate Company Brief" button (bottom-left of the
                                           profile card), handler, briefBusy state, css ?v= bump
modules/my-company/my-company.css        + .mc__brief (margin-right:auto)
modules/my-company/company-brief.js      NEW — gathers files, calls the Worker, renders
modules/my-company/company-brief-pdf.js  NEW — jsPDF renderer (cover ribbon, boxes, tables)

No index.html change: company-brief.js and the PDF builder are lazy-loaded on click.
The Mktforge logo comes from assets/img/mktforge-logo.png (already in the repo).
The PDF saves as "Company Brief N" under Generated Materials via savePdfDoc.
