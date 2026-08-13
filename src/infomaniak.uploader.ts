const API_URL = 'https://api.infomaniak.com';
const API_VERSION = '3';

export interface InfomaniakUploaderOptions {
  folderUrl: string;
  token: string;
}

interface UploadSuccessResponse {
  result: 'success';
  data: {
    id: string;
    name: string;
    type: 'dir' | 'file';
    status: string;
    visibility: string;
    drive_id: number;
    depth: number;
    created_by: number;
    created_at: number;
    added_at: number;
    last_modified_at: number;
    last_modified_by: number;
    revised_at: number;
    updated_at: number;
    parent_id: number;
    size: number;
    mime_type: string;
    extension_type: string;
    scan_status: string;
  };
}

interface UploadErrorResponse {
  result: 'error';
  error: {
    code: string;
    description: string;
  };
}

type UploadResponse = UploadSuccessResponse | UploadErrorResponse;

const extractIds = (url: string): { driveId: string; folderId: string } => {
  const regex = /.+\.infomaniak\.com\/[0-9]+\/kdrive\/app\/drive\/([0-9]+)\/files\/([0-9]+)/;
  const match = regex.exec(url);
  if (!match) {
    throw new Error('Invalid folder URL');
  }

  return { driveId: match[1], folderId: match[2] };
};

class InfomaniakUploader {
  #driveId: string;

  #folderId: string;

  #token: string;

  constructor(options: InfomaniakUploaderOptions) {
    this.#token = options.token;
    const { driveId, folderId } = extractIds(options.folderUrl);
    this.#driveId = driveId;
    this.#folderId = folderId;
  }

  uploadFile = async (file: File, path?: string): Promise<void> => {
    const queryParams = new URLSearchParams({
      file_name: file.name,
      total_size: file.size.toString(),
      directory_id: this.#folderId,
      ...(path ? { directory_path: path } : {}),
    });
    const formData = new FormData();
    formData.append('data', file);

    const response = await fetch(
      `${API_URL}/${API_VERSION}/drive/${this.#driveId}/upload?${queryParams.toString()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to initiate upload: ${response.statusText}`);
    }

    const data: UploadResponse = await response.json();

    if (data.result === 'error') {
      throw new Error(`Upload error: ${JSON.stringify(data.error)}`);
    }

    console.log(`File uploaded successfully: ${data.data.name} (ID: ${data.data.id})`);
  };
}

export default InfomaniakUploader;
