# The voice Lambda (handler.py). Built from acoustic-model/ so it can copy the evaluated src/:
#   docker build -f voice_service/Dockerfile -t mzazi-voice .
FROM public.ecr.aws/lambda/python:3.13

# CPU builds of PyTorch, as in venv-speaker and the Colab run: the default Linux builds need CUDA.
RUN pip install --no-cache-dir torch==2.14.1+cpu torchaudio==2.11.1+cpu \
      --index-url https://download.pytorch.org/whl/cpu
COPY voice_service/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY src/ ${LAMBDA_TASK_ROOT}/src/
COPY voice_service/handler.py voice_service/fetch_model.py ${LAMBDA_TASK_ROOT}/
ENV PYTHONPATH=${LAMBDA_TASK_ROOT}/src
RUN python ${LAMBDA_TASK_ROOT}/fetch_model.py ${LAMBDA_TASK_ROOT}/model

# Nothing is fetched at runtime, and only /tmp is writable in Lambda.
ENV HF_HUB_OFFLINE=1 \
    HF_HOME=/tmp/hf \
    TORCH_HOME=/tmp/torch \
    MODEL_DIR=${LAMBDA_TASK_ROOT}/model

CMD ["handler.handler"]
