import * as fileService from './file.service.js';
function ok(res, req, data, status = 200) {
    res.status(status).json({ data, meta: { correlationId: req.correlationId } });
}
export async function postFile(req, res) {
    const { mime, sizeBytes } = req.body;
    const result = await fileService.createUploadTarget(mime, sizeBytes, req.auth);
    ok(res, req, result, 201);
}
export async function getDownloadUrl(req, res) {
    const result = await fileService.createDownloadUrl(req.params.id);
    ok(res, req, result);
}
