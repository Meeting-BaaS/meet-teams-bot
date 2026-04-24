import axios from "axios"
import axiosRetry from "axios-retry"
import { envVars } from "../config/env-vars"

const axiosInstance = axios.create({
  baseURL: envVars.API_SERVER_BASEURL,
  timeout: 30000
})

axiosRetry(axiosInstance, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => axiosRetry.isNetworkError(error) || axiosRetry.isRetryableError(error),
  onRetry: (retryCount, error, requestConfig) => {
    console.warn(
      `HTTP retry attempt ${retryCount}:`,
      requestConfig.method?.toUpperCase(),
      requestConfig.url,
      error.message
    )
  }
})

export default axiosInstance
